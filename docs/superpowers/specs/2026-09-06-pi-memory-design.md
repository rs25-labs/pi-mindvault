# pi-mindvault — Pi sqlite Memory (Hermes + Honcho-lite) — Design
Repo: https://github.com/rs25-labs/pi-mindvault
Tagline: Local-first sqlite memory for pi — Hermes durability, Honcho-style recall, no server.
Date: 2026-09-06
Status: approved (params locked, no code yet)
Location: `~/.pi/memory/memory.db`

## Decisions
- Q1 Identity: B — Honcho-lite hierarchy (`workspace / peers[user+agent] / sessions / scopes`), per-repo/per-directory mapping
- Q2 Engine: A — single sqlite file, WAL, FTS5 + sqlite-vec, no server (Hermes state.db pattern)
- Q3 Types: C — hybrid (`episodic / semantic~observations / procedural / working`) + `peer_cards` + `summaries`
- Q4 Write: C — auto-extract + explicit `remember/conclude`, explicit always wins (supersedes)
- Q5 Retrieval: B — hybrid RRF (vector + FTS5 BM25), recency+importance, scopes filter, pluggable embeddings (local default, API fallback)
- Q6 Consolidation: C — auto-summarize on session end + Dreamer dedupe + manual vacuum/rebuild/prune, explicit never decays
- Q7 Privacy: B — cwd-jail + redaction + cascade delete + scopes as ACL
- Q8 API: A — Hermes 4-tool clone (`memory_profile / memory_search / memory_context / memory_conclude`) + auto-inject; default `per-directory`, `global` for user cards + procedural rules
- Q9 Observability: B — score+source+scope + `memory status` + hit/miss log linked to pi session IDs

## §1 Architecture + files
- `~/.pi/memory/memory.db` (+ `-wal`/`-shm`), `PRAGMA journal_mode=WAL`, `foreign_keys=ON`
- `sqlite-vec` (`vec_observations`) + FTS5 `fts_observations` (external-content), trigram + LIKE fallback, fail-open detach
- In-process writer + background Deriver/Dreamer; `queue` + `state_meta(schema_version, embedding_dim/model, fts_high_water, dream_cursor)`
- Identity: `workspace='pi'`, `peers('<user>','pi-agent')`, `sessions(pi_session_id, cwd, repo, scope)`, `scopes(global, dir:<path>, repo:<root>)`
- Embeddings pluggable; store dim/model to detect change

## §2 Schema
- `workspaces(id, config_json)`; `peers(id, workspace_id, kind, created_at)`; `scopes(id, workspace_id, kind, key)`
- `sessions(id, workspace_id, pi_session_id UNIQUE, cwd, repo_root, scope_id, summary, started_at, ended_at)` ↔ `~/.pi/agent/sessions/*.jsonl`
- `session_peers(session_id, peer_id)`
- `messages(id PK, session_id, peer_id, role, content, timestamp, token_count)`
- `observations(id, workspace_id, peer_id, session_id, scope_id, mem_type, content, importance, explicit, supersedes_id, expiry, accesses, created_at, updated_at, embedding)`
- `fts_observations` (FTS5) + `vec_observations(rowid, embedding)`
- `peer_cards(peer_id, scope_id UNIQUE, content, updated_at)`; `summaries(id, session_id, peer_id, kind, content, tokens, created_at)`
- `queue(id, session_id, status, attempts, payload_json, created_at)`; `recall_log(id, query, scope_id, result_ids_json, scores_json, hit, pi_session_id, timestamp)`; `state_meta(key, value)`
- Indexes: `(peer_id, scope_id, mem_type)`, `(session_id, timestamp)`, `(scope_id, importance DESC)`. Cascade deletes.

## §3 Write flow
- Buffer `messages` + `queue(pending)`; turn job every N=4, session-end drain
- Deriver FIFO per-session → `observations{mem_type, importance, scope_id}` (default `dir:<cwd>`, opt `global`)
- Redact secrets + cwd-jail (`<outside-cwd>`)
- Dedupe via vector+FTS; explicit wins (supersedes_id); non-explicit merges `max(importance)`
- Failures retry x3 → `queue_status`; raw writes always succeed

## §4 Read flow
- Inject: `peer_cards(user, global+dir)` + `procedural/global` into prompt (`memory_profile`)
- `memory_search`: vec top-20 + FTS top-20 → RRF → scope/expiry filter → `0.6*RRF+0.25*recency+0.15*importance`, explicit boost
- `memory_context`: top-8 → LLM synthesis with `[id]` cites, reasoning `low` default
- `recallMode=hybrid` (switchable); miss → `hit=0` + fallback to summaries/recent

## §5 Scopes/Privacy + Consolidation
- Read filter `scope IN (global, dir:cwd, repo:root)`; cascade delete; `forget(id)` hard-delete
- Dreamer: session-end summary; periodic merge/dedupe; decay `episodic importance<0.3, accesses=0, age>30d`; explicit/procedural-global never decay; updates cards
- Manual `memory_optimize`: WAL checkpoint + FTS rebuild (chunked, admission lock) + VACUUM + prune

## §6 Tools/Obs/Errors/Testing
- Tools: `memory_profile/search/context/conclude`; auto-sync post-turn, auto-inject pre-turn; offline = cards + FTS-only, queue writes
- Obs: `recall_log` + `memory status` (size, counts, queue, last Dreamer, embedding info)
- Errors: fail-open, detach+rebuild breadcrumb
- Tests: cross-session recall, explicit-wins, scope isolation, FTS-fallback, prune-never-explicit

## Self-review
- No TBD/TODO; params locked Q1-Q9
- Consistent: single-file WAL ↔ fail-open ↔ chunked rebuild; scopes ACL ↔ per-directory default + global cards; explicit-wins ↔ never-decay
- Scope: single workspace `pi` v1; multi-workspace reserved, no server, no auto-embeddings training
- Unambiguous: `per-directory` default; `global` only for user cards + procedural; RRF weights fixed v1; N=4 turn cadence; 30d episodic decay threshold

## Next
- Writing-plans skill → implementation plan (no code until plan approved)
