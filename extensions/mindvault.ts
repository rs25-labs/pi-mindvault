import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { homedir } from "node:os";
import { join } from "node:path";
import { openMindvault, remember, recallSearch, getProfile, dbStatus, forgetObservation } from "./lib/db.ts";
import { scopeKeysForRead, resolveScope, gitRootSync } from "./lib/scopes.ts";

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
      const cards = getProfile(db, { peer: "user", scopeKeys: ctxScopes(ctx.cwd) });
      db.close();
      if (cards.length === 0) return;
      return { systemPrompt: event.systemPrompt + "\n\n# Long-term memory (pi-mindvault)\n" + cards.join("\n").slice(0, 3000) };
    } catch { return; }
  });

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
      ctx.ui.notify(`mindvault: schema=${st.schemaVersion} obs=${st.observations} fts=${st.ftsCount} queue=${st.queuePending} vec=${st.vecMode} dim=${st.embeddingDim ?? "?"}`, "info");
    },
  });
}
