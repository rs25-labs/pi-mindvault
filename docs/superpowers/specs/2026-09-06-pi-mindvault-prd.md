# pi-mindvault — PRD
Repo: https://github.com/rs25-labs/pi-mindvault
Tagline: Local-first sqlite memory for pi — Hermes durability, Honcho-style recall, no server.
Date: 2026-09-06
Status: draft for review (design params locked 2026-09-06)
Author: pi

## 1. Problem
pi coding agent sessions are stateless across restarts. Users repeat preferences, project decisions, and working rules every session. Existing RAG snippets miss latent facts, contradict, and leak across repos. Server memory (managed Honcho) adds network dep + data egress. Hermes proves single-file sqlite (`state.db` + FTS5 + WAL) can be durable and fast; Honcho proves peer/session/scope + background reasoning yields high retention.

## 2. Goals (P0)
- Single-file local memory: `~/.pi/memory/memory.db` (+ `-wal`/`-shm`), `PRAGMA journal_mode=WAL`, no server.
- Honcho-lite hierarchy: `workspace / peers (user+agent) / sessions / scopes`, default `workspace=pi`.
- Hybrid memory types: `episodic / semantic~observations / procedural / working` + `peer_cards` + `summaries`.
- 4-tool pi extension: `memory_profile / memory_search / memory_context / memory_conclude` + auto-inject cached profile pre-turn, auto-sync post-turn.
- Hybrid recall: `sqlite-vec` cosine + FTS5 BM25 fused via RRF, weighted recency+importance, scopes ACL filter, explicit-wins.
- Offline-safe: cards + FTS-only fallback, queued writes, fail-open detach like Hermes.
- Privacy: cwd-jail, secret redaction, cascade delete, `forget(id)`, scopes as ACL, explicit never decays.

## 3. Non-goals (v1)
- No server, no multi-device sync, no managed embeddings training.
- No multi-workspace UI; single `pi` workspace, schema reserves multi-app.
- No auto-training of custom reasoning models; Deriver/Dreamer use host LLM via pi provider (pluggable embeddings: local default, API fallback).
- No full Honcho dialectic engine; `memory_context` is top-k synthesis with cites.

## 4. Users + use cases
- Solo pi user across repos: save “prefer explicit types” in `dir:~/projA`, invisible in `dir:~/projB`; save “my handle is <user>” as `global` visible everywhere.
- Agent continuity: `peer_cards(user, global)` injected every turn; `memory_search("sqlite-vec policy")` returns excerpts; `memory_context` synthesizes answer.
- Correction: user says “actually WAL off for this repo” via `memory_conclude(explicit)` → supersedes prior, wins forever.

## 5. Functional requirements
### 5.1 Identity / scopes
- FR1: `workspaces(id='pi')`, `peers(<user>, pi-agent)`, `session_peers` dual-peer.
- FR2: `scopes(global, dir:<cwd>, repo:<root>, session:<id>)`; default write `dir:<cwd>` (per-directory); opt-in `global` for identity + procedural rules.
- FR3: Every read filters `scope IN (global, dir:cwd, repo:root)`; `dir` never leaks cross-dir.
### 5.2 Storage
- FR4: WAL, `foreign_keys=ON`, `state_meta(schema_version, embedding_dim/model, fts_high_water, dream_cursor)`.
- FR5: `messages` raw buffer; `observations(mem_type, content, importance, explicit, supersedes_id, expiry, accesses, embedding)`; `fts_observations` FTS5 external-content; `vec_observations` via `sqlite-vec`; `peer_cards(peer,scope UNIQUE)`; `summaries(session|peer)`; `queue(status,attempts,payload)`; `recall_log(query,scope,ids,scores,hit,pi_session_id)`; cascade deletes.
- FR6: FTS5/trigram + LIKE fallback; vector missing → FTS-only (degraded, logged).
### 5.3 Write (Deriver)
- FR7: Buffer `messages` + `queue(pending)` inline (fast turns); drain every N=4 turns + forced on session end.
- FR8: FIFO per-session Deriver → atomic `observations{mem_type,importance,scope}`; redact secrets (`KEY=`, `ghp_/sk-`, PEM) + cwd-jail (`<outside-cwd>`).
- FR9: Dedupe via vector+FTS in same `(peer,scope)`; explicit sets `supersedes_id`; non-explicit merges `max(importance)`; retry x3 → `failed` surfaces in `queue_status`.
### 5.4 Read
- FR10: Pre-turn inject `peer_cards(user, global+dir)` + `procedural/global` (zero-latency `memory_profile`).
- FR11: `memory_search(query,scope?,limit?)` vec top-20 + FTS top-20 → RRF → scope/expiry filter → `0.6*RRF+0.25*recency+0.15*importance`, explicit boost; returns `{id,content,score,source,scope}` + `recall_log`.
- FR12: `memory_context(query)` top-8 → LLM synthesis with `[id]` cites, reasoning `low` default; `recallMode=hybrid` (switchable `context|tools`).
- FR13: Miss (top score < threshold) → `hit=0` + fallback summaries/recent.
### 5.5 Consolidation (Dreamer)
- FR14: Session-end `summaries(session)` (40% summary / 60% recent for context budgeting); periodic merge/dedupe; decay `episodic importance<0.3 AND accesses=0 AND age>30d`; explicit + `procedural/global` never decay; refresh `peer_cards`.
- FR15: Manual `memory_optimize`: WAL checkpoint + chunked FTS `rebuild` (admission lock) + `VACUUM` + `prune --older-than`.
### 5.6 Privacy / deletion
- FR16: `forget(id)` hard-deletes + FTS/vec purge; `delete-session/scope/workspace` cascades; `expiry` honored on read.
### 5.7 Observability
- FR17: `memory status`: DB size, counts by `mem_type/scope`, `queue_status`, last Dreamer, embedding model/dim.
- FR18: `recall_log` links to `~/.pi/agent/sessions/*.jsonl` via `pi_session_id` for hit/miss tuning.

## 6. Non-functional
- NFR1: Turn overhead p95 <50ms added when worker idle (buffer only); search p95 <300ms on 100k observations (local).
- NFR2: Crash-safe (WAL + atomic queue transitions); corrupt FTS → detach + LIKE, breadcrumb, later rebuild.
- NFR3: No network required for `profile/search(FTS)`; embeddings API fallback only when configured.
- NFR4: Never commit absolute local paths or usernames; use `~/.pi` and `<user>` in docs/commits (enforced by local pre-commit hook).

## 7. API + pi integration
- Tools (pi extension manifest): `memory_profile`, `memory_search`, `memory_context`, `memory_conclude(content, mem_type, scope?)`.
- Hooks: `pre-turn` inject, `post-turn` sync (configurable `writeFrequency: async|turn|session|N`, `recallMode: hybrid|context|tools`, `sessionStrategy: per-directory|per-repo|per-session|global`).
- CLI (v1 minimal): `memory status | search <q> | remember <text> | forget <id> | optimize`.

## 8. Milestones
- M1: schema + WAL + CRUD + FTS5, 4 tools stub, `status` (accept: cross-session recall test passes).
- M2: `sqlite-vec` + RRF + scopes ACL + redaction (accept: scope isolation, explicit-wins tests).
- M3: async queue + Deriver + session summaries + auto-inject (accept: p95 overhead, offline queue test).
- M4: Dreamer + `optimize` + `recall_log` tuning + docs + npm publish `@rs25-labs/pi-mindvault`.

## 9. Testing / acceptance
- cross-session recall (save in A, recall in new session B).
- explicit-wins supersede.
- scope isolation (`dir:A` invisible from `dir:B`, `global` visible both).
- FTS-fallback (vec disabled → still recalls).
- prune-never-explicit (aged explicit survives).
- redaction (secret patterns never stored verbatim).
- corruption fail-open (drop FTS → writes still succeed).

## 10. Risks
- `sqlite-vec` native dep weight → mitigate FTS-only mode + pluggable embeddings.
- Embedding dim drift → store dim/model, re-embed on mismatch (background).
- DB growth → chunked rebuild + prune + `VACUUM`; cap + `queue_status` visibility.
- Over-recall noise → RRF weights fixed v1, tune via `recall_log`.

## 11. Open questions
- None blocking; defaults locked: per-directory default, N=4, RRF `0.6/0.25/0.15`, 30d episodic decay, reasoning `low`.

## References
- Design spec: `docs/superpowers/specs/2026-09-06-pi-memory-design.md`
- Inspirations: Hermes `state.db` (WAL + FTS5 + triggers + fail-open), Honcho (workspace/peers/sessions, Deriver/Dreamer, representation/chat/search/context, scopes, dreaming), pi-honcho-memory (per-repo/dir mapping, auto-inject, graceful offline).
