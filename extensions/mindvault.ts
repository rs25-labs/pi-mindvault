import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { homedir } from "node:os";
import { join } from "node:path";
import { openMindvault, remember, recallSearch, getProfile, dbStatus, forgetObservation, markUsed, embedUpgrade, explainObservation, editObservation, seedVault } from "./lib/db.ts";
import { embed, isAsyncProvider, setActiveEmbedder } from "./lib/embeddings.ts";
import { loadConfig, writeConfig, type MindvaultConfig } from "./lib/config.ts";
import { scopeKeysForRead, resolveScope, gitRootSync } from "./lib/scopes.ts";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { ingestMessage, drainQueue, queueStatus } from "./lib/worker.ts";
import { buildContext } from "./lib/context.ts";
import { optimizeNow } from "./lib/maint.ts";
import { dream, pruneIfOverCap } from "./lib/dreamer.ts";
import { deleteScope } from "./lib/db.ts";

function dbPath(): string {
  return join(homedir(), ".pi", "memory", "memory.db");
}

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));

async function fastembedAvailable(): Promise<boolean> {
  try { const spec = "fastembed"; await import(spec); return true; } catch { return false; }
}

export default function (pi: ExtensionAPI) {
  const getDb = () => openMindvault(dbPath());
  const quiet = loadConfig().quiet;
  const ctxScopes = (cwd: string) => {
    const repo = gitRootSync(cwd);
    return scopeKeysForRead({ cwd, repoRoot: repo });
  };

  pi.on("session_start", async (_event, ctx) => {
    try {
      const db = getDb();
      const cards = getProfile(db, { peer: "user", scopeKeys: ctxScopes(ctx.cwd) });
      db.close();
      if (cards.length > 0 && !quiet) ctx.ui.notify(`mindvault: ${cards.length} profile block(s) loaded`, "info");
    } catch { /* offline-safe: never block startup */ }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const db = getDb();
      const repo = gitRootSync(ctx.cwd);
      const built = buildContext(db, { cwd: ctx.cwd, repoRoot: repo, tokenBudget: 2000 });
      db.close();
      if (!built.text.trim()) return;
      return { systemPrompt: event.systemPrompt + "\n\n" + built.text };
    } catch { return; }
  });

  pi.on("agent_end", async (_event, ctx) => {
    // best-effort post-turn sync: ingest unseen entries, bounded drain (never blocks shutdown)
    try {
      const db = getDb();
      const sessionId = ctx.sessionManager.getSessionFile() ?? `cwd:${ctx.cwd}`;
      // dedupe on content prefix: ingested rows carry ingest-time stamps, so entry
      // timestamps can never match — content is the stable key within a session.
      const known = new Set((db.prepare("SELECT content FROM messages WHERE session_id=?").all(sessionId) as { content: string }[]).map((r) => String(r.content).slice(0, 80)));
      const entries = ctx.sessionManager.getEntries();
      let added = 0;
      for (const e of entries.slice(-30)) {
        if (e.type !== "message" || !("content" in e.message)) continue;
        const role = (e.message as { role: string }).role;
        const text = flattenContent(e.message.content);
        if (!text || text.length < 24) continue;
        if (known.has(text.slice(0, 80))) continue;
        ingestMessage(db, { sessionId, peer: role === "assistant" ? "pi-agent" : "user", role: role === "assistant" ? "assistant" : role === "user" ? "user" : "tool", content: text, cwd: ctx.cwd });
        added++;
        if (added >= 10) break;
      }
      if (added > 0) drainQueue(db, { limit: 20 });
      if (isAsyncProvider()) await embedUpgrade(db, 50);
      pruneIfOverCap(db);
      db.close();
    } catch { /* sync never breaks the agent loop */ }
  });

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b === "object" && "text" in (b as Record<string, unknown>) ? String((b as Record<string, unknown>).text) : "")).join("\n");
  }
  return "";
}

  pi.registerTool({
    name: "memory_profile",
    label: "Memory Profile",
    description: "Fast peer card retrieval (no LLM). Returns curated facts about the user.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const db = getDb();
      const cards = getProfile(db, { peer: "user", scopeKeys: ctxScopes(ctx.cwd) });
      db.close();
      return { content: [{ type: "text" as const, text: cards.join("\n") || "(no profile yet)" }], details: {} };
    },
  });

  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description: "Hybrid search over local memory. Returns raw excerpts ranked by relevance.",
    parameters: Type.Object({ query: Type.String({ description: "Search query" }), limit: Type.Optional(Type.Number()) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const db = getDb();
      const queryVector = isAsyncProvider() ? await embed(params.query) : undefined;
      const hits = recallSearch(db, { query: params.query, scopeKeys: ctxScopes(ctx.cwd), limit: params.limit ?? 5, queryVector });
      db.close();
      const text = hits.map((h) => `[${h.id}] (${h.source} ${h.scopeKey}) ${h.content}`).join("\n") || "(no hits)";
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });

  pi.registerTool({
    name: "memory_context",
    label: "Memory Context",
    description: "Synthesized answer from memory excerpts (M1: extractive, LLM synthesis lands in M3).",
    parameters: Type.Object({ query: Type.String({ description: "Question about memory" }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const db = getDb();
      const queryVector = isAsyncProvider() ? await embed(params.query) : undefined;
      const hits = recallSearch(db, { query: params.query, scopeKeys: ctxScopes(ctx.cwd), limit: 8, queryVector });
      db.close();
      const text = hits.map((h) => `[${h.id}] ${h.content}`).join("\n") || "(no context)";
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });

  pi.registerTool({
    name: "memory_used",
    label: "Memory Used",
    description: "Mark recalled memory ids that actually informed the answer. Strengthens their ranking and protects them from decay.",
    parameters: Type.Object({ ids: Type.Array(Type.Number(), { description: "Observation ids from memory_search that were useful" }) }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const db = getDb();
      const n = markUsed(db, params.ids);
      db.close();
      return { content: [{ type: "text" as const, text: `marked ${n} memory(ies) used` }], details: {} };
    },
  });

  pi.registerTool({
    name: "memory_conclude",
    label: "Memory Conclude",
    description: "Save a durable fact. Explicit saves always win conflicts and never decay.",
    parameters: Type.Object({
      content: Type.String({ description: "Fact to remember" }),
      memType: Type.Optional(Type.Union([Type.Literal("episodic"), Type.Literal("semantic"), Type.Literal("procedural"), Type.Literal("working")])),
      global: Type.Optional(Type.Boolean({ description: "Save to global scope (default: current directory)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const db = getDb();
      const repo = gitRootSync(ctx.cwd);
      const scope = resolveScope({ cwd: ctx.cwd, repoRoot: repo, explicit: params.global ? "global" : null });
      const id = remember(db, { peer: "user", content: params.content, memType: params.memType ?? "semantic", scopeKey: scope.key, explicit: 1, cwd: ctx.cwd });
      if (isAsyncProvider()) await embedUpgrade(db);
      db.close();
      return { content: [{ type: "text" as const, text: `remembered #${id} in ${scope.key}` }], details: {} };
    },
  });

  pi.registerTool({
    name: "memory_why",
    label: "Memory Why",
    description: "Explain one memory: scope, type, importance, access count, supersede chain, and how it scored in the last recall that returned it.",
    parameters: Type.Object({ id: Type.Number({ description: "Observation id from memory_search" }) }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const db = getDb();
      const ex = explainObservation(db, params.id);
      db.close();
      if (!ex) return { content: [{ type: "text" as const, text: `not found #${params.id}` }], details: {} };
      const lr = ex.lastRecall ? `query="${ex.lastRecall.query}" score=${ex.lastRecall.score?.toFixed(3) ?? "?"} used=${ex.lastRecall.used}` : "(not in recent recalls)";
      const text = [
        `#${ex.id} in ${ex.scopeKey} (${ex.memType})`,
        `importance=${ex.importance} explicit=${ex.explicit} accesses=${ex.accesses}`,
        ex.supersedes.length ? `supersedes: ${ex.supersedes.join(", ")}` : "supersedes: none",
        `last recall: ${lr}`,
        `content: ${ex.content}`,
      ].join("\n");
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });

  pi.registerTool({
    name: "memory_inspect",
    label: "Memory Inspect",
    description: "Show exactly what mindvault would inject into the system prompt this turn (profile + summary + recent), with token counts.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const db = getDb();
      const repo = gitRootSync(ctx.cwd);
      const built = buildContext(db, { cwd: ctx.cwd, repoRoot: repo, tokenBudget: 2000 });
      db.close();
      const text = `~${built.summaryTokens + built.recentTokens} tokens (summary=${built.summaryTokens}, recent=${built.recentTokens})\n\n${built.text || "(nothing to inject)"}`;
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });

  pi.registerTool({
    name: "memory_edit",
    label: "Memory Edit",
    description: "Correct one memory in place by id: redacts, re-indexes for search, and re-embeds.",
    parameters: Type.Object({ id: Type.Number({ description: "Observation id from memory_search" }), content: Type.String({ description: "Replacement text" }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const db = getDb();
      const ok = editObservation(db, { id: params.id, content: params.content, cwd: ctx.cwd });
      if (ok && isAsyncProvider()) await embedUpgrade(db);
      db.close();
      return { content: [{ type: "text" as const, text: ok ? `edited #${params.id}` : `not found #${params.id}` }], details: {} };
    },
  });

  pi.registerTool({
    name: "memory_forget",
    label: "Memory Forget",
    description: "Hard-delete one memory by id (purges FTS + vector). Use for corrections and privacy.",
    parameters: Type.Object({ id: Type.Number({ description: "Observation id from memory_search" }) }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const db = getDb();
      const ok = forgetObservation(db, params.id);
      db.close();
      return { content: [{ type: "text" as const, text: ok ? `forgot #${params.id}` : `not found #${params.id}` }], details: {} };
    },
  });

  pi.registerTool({
    name: "memory_optimize",
    label: "Memory Optimize",
    description: "Run maintenance: checkpoint, FTS rebuild, embedding backfill, Dreamer pass, expiry prune, vacuum. Slow on large DBs.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, _ctx) {
      const db = getDb();
      const rep = optimizeNow(db, {});
      if (isAsyncProvider()) await embedUpgrade(db, 2000);
      db.close();
      return { content: [{ type: "text" as const, text: `optimize: checkpoint=${rep.checkpoint} fts=${rep.ftsRebuild} backfilled=${rep.backfilled} merged=${rep.dreamed.merged} pruned=${rep.dreamed.pruned}+${rep.prunedExpired} vacuum=${rep.vacuum}` }], details: {} };
    },
  });

  pi.registerCommand("dream", {
    description: "Run Dreamer consolidation (dedupe, decay, card refresh)",
    handler: async (_args, ctx) => {
      const db = getDb();
      const s = dream(db, {});
      db.close();
      ctx.ui.notify(`dream: merged=${s.merged} pruned=${s.pruned} cards=${s.cards}`, "info");
    },
  });

  pi.registerCommand("memory-prune", {
    description: "Delete one scope (e.g. memory-prune dir:/tmp/scratch)",
    handler: async (args, ctx) => {
      const scope = String(args ?? "").trim();
      if (!scope) { ctx.ui.notify("usage: memory-prune <scopeKey> (e.g. global, dir:/path)", "error"); return; }
      const db = getDb();
      const n = deleteScope(db, scope);
      db.close();
      ctx.ui.notify(`pruned ${n} memories from ${scope}`, "info");
    },
  });

  pi.registerCommand("mindvault-setup", {
    description: "Initialize local mindvault DB",
    handler: async (_args, ctx) => {
      const db = getDb();
      const repo = gitRootSync(ctx.cwd);
      const seeded = seedVault(db, { cwd: ctx.cwd, repoRoot: repo });
      const st = dbStatus(db);
      db.close();
      ctx.ui.notify(`mindvault ready (schema ${st.schemaVersion}, ${st.observations} memories, ${seeded.peers} peers, ${seeded.scopes} scopes)`, "info");
    },
  });

  pi.registerCommand("mindvault-config", {
    description: "View or set config (embeddings <hash|local|api>, quiet <on|off>, maxObs <n>) — no env vars needed",
    handler: async (args, ctx) => {
      const parts = String(args ?? "").trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        const c = loadConfig();
        ctx.ui.notify(`config: embeddings=${c.embeddings.provider}${c.embeddings.model ? ` (${c.embeddings.model})` : ""} quiet=${c.quiet} maxObs=${c.maxObs}`, "info");
        return;
      }
      const [key, value] = parts;
      if (key === "embeddings") {
        const p = (value ?? "").toLowerCase();
        if (p !== "hash" && p !== "local" && p !== "api") { ctx.ui.notify("usage: /mindvault-config embeddings <hash|local|api>", "error"); return; }
        const embeddings: MindvaultConfig["embeddings"] = { provider: p };
        if (p === "local") { embeddings.model = "fast-bge-small-en-v1.5"; embeddings.dim = 384; }
        writeConfig({ embeddings });
        setActiveEmbedder(null); // clear cached embedder so a later open in this session re-reads config
        let extra = " — takes effect next session";
        if (p === "local") extra += (await fastembedAvailable()) ? "; model downloads on first use" : `; first run: (cd ${pkgDir} && npm install fastembed)`;
        if (p === "api") extra += "; set url/key/model/dim in config.json or MINDVAULT_EMBEDDINGS_* env";
        ctx.ui.notify(`embeddings set to ${p}${extra}`, "info");
        return;
      }
      if (key === "quiet") {
        const on = value === "on" || value === "true" || value === "1";
        writeConfig({ quiet: on });
        ctx.ui.notify(`quiet ${on ? "on" : "off"} — takes effect next session`, "info");
        return;
      }
      if (key === "maxobs" || key === "maxobservations") {
        const n = Number(value);
        if (!(n > 0)) { ctx.ui.notify("usage: /mindvault-config maxObs <positive number>", "error"); return; }
        writeConfig({ maxObs: n });
        ctx.ui.notify(`maxObs set to ${n} — takes effect next session`, "info");
        return;
      }
      ctx.ui.notify("usage: /mindvault-config [embeddings <hash|local|api> | quiet <on|off> | maxObs <n>]", "error");
    },
  });

  pi.registerCommand("memory", {
    description: "memory status",
    handler: async (_args, ctx) => {
      const db = getDb();
      const st = dbStatus(db);
      const q = queueStatus(db);
      let hit = "(no queries yet)";
      try {
        const r = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(hit),0) AS h FROM recall_log").get() as { n: number; h: number };
        if (r.n > 0) hit = `${Math.round((r.h / r.n) * 100)}% of ${r.n}`;
      } catch { /* ignore */ }
      db.close();
      ctx.ui.notify(`mindvault: schema=${st.schemaVersion} obs=${st.observations} fts=${st.ftsCount} queue=${st.queuePending}+${q.pending}p/${q.failed}f vec=${st.vecMode} dim=${st.embeddingDim ?? "?"} recall-hit=${hit}`, "info");
    },
  });
}
