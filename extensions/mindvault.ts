import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { homedir } from "node:os";
import { join } from "node:path";
import { openMindvault, remember, recallSearch, getProfile, dbStatus, forgetObservation } from "./lib/db.ts";
import { scopeKeysForRead, resolveScope, gitRootSync } from "./lib/scopes.ts";
import { ingestMessage, drainQueue, queueStatus } from "./lib/worker.ts";
import { buildContext } from "./lib/context.ts";

function dbPath(): string {
  return join(homedir(), ".pi", "memory", "memory.db");
}

export default function (pi: ExtensionAPI) {
  const getDb = () => openMindvault(dbPath());
  const ctxScopes = (cwd: string) => {
    const repo = gitRootSync(cwd);
    return scopeKeysForRead({ cwd, repoRoot: repo });
  };

  pi.on("session_start", async (_event, ctx) => {
    try {
      const db = getDb();
      const cards = getProfile(db, { peer: "user", scopeKeys: ctxScopes(ctx.cwd) });
      db.close();
      if (cards.length > 0) ctx.ui.notify(`mindvault: ${cards.length} profile block(s) loaded`, "info");
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
      const hits = recallSearch(db, { query: params.query, scopeKeys: ctxScopes(ctx.cwd), limit: params.limit ?? 5 });
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
      const hits = recallSearch(db, { query: params.query, scopeKeys: ctxScopes(ctx.cwd), limit: 8 });
      db.close();
      const text = hits.map((h) => `[${h.id}] ${h.content}`).join("\n") || "(no context)";
      return { content: [{ type: "text" as const, text }], details: {} };
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
      db.close();
      return { content: [{ type: "text" as const, text: `remembered #${id} in ${scope.key}` }], details: {} };
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

  pi.registerCommand("mindvault-setup", {
    description: "Initialize local mindvault DB",
    handler: async (_args, ctx) => {
      const db = getDb();
      const st = dbStatus(db);
      db.close();
      ctx.ui.notify(`mindvault ready (schema ${st.schemaVersion}, ${st.observations} memories)`, "info");
    },
  });

  pi.registerCommand("memory", {
    description: "memory status",
    handler: async (_args, ctx) => {
      const db = getDb();
      const st = dbStatus(db);
      db.close();
      const q = queueStatus(db);
      ctx.ui.notify(`mindvault: schema=${st.schemaVersion} obs=${st.observations} fts=${st.ftsCount} queue=${st.queuePending}+${q.pending}p/${q.failed}f vec=${st.vecMode} dim=${st.embeddingDim ?? "?"}`, "info");
    },
  });
}
