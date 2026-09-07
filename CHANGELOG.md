# Changelog

## 0.2.5 — 2026-09-06
- `/memory` now reports the active embedder (e.g. `emb=local:fast-bge-small-en-v1.5` or
  `emb=feature-hash`), and flags `unavailable→feature-hash` when `local` is selected but
  the runtime can't load — so it's unambiguous which embedder is actually in use.

## 0.2.4 — 2026-09-06
- Fix: the local embedding provider crashed pi with an uncaught `ENOENT ... local_cache/…`
  on first use. Two causes: the model id was fastembed's HuggingFace name
  (`BAAI/bge-small-en-v1.5`) instead of its own key (`fast-bge-small-en-v1.5`), and no
  cache directory was set (fastembed's default `local_cache` is relative and uncreated, so
  its download stream raised an uncatchable error). Now uses the correct key and an
  absolute, pre-created cache dir (`~/.pi/memory/models`). Validated end-to-end against
  fastembed 2.1.0 (real 384-dim vectors).
- Older configs that stored the HuggingFace model id self-heal to the fastembed key.

## 0.2.3 — 2026-09-06
- Fix: `/memory` closed the database before reading queue status and recall hit-rate,
  throwing "database is not open". Now closes after all reads.

## 0.2.2 — 2026-09-06
- Config file: `~/.pi/memory/config.json` (set via `/mindvault-config`) now drives the
  embedding provider, quiet mode, and size cap — no environment variables required.
  Env vars remain supported as optional overrides.
- New `/mindvault-config` command: `embeddings <hash|local|api>`, `quiet <on|off>`,
  `maxObs <n>`; choosing `local` fills in the correct model (`BAAI/bge-small-en-v1.5`)
  and dim (384), and reports if `fastembed` still needs installing.
- Fix: local provider default model id corrected to `BAAI/bge-small-en-v1.5`.

## 0.2.1 — 2026-09-06
- Setup: `/mindvault-setup` now seeds the `user`/`pi-agent` peers and `global` + current
  directory scopes (previously it only reported status), so a fresh vault is complete on
  first run
- Quiet mode: `MINDVAULT_QUIET=1` suppresses the passive per-session status banner
- Docs: plain-English README intro (lightweight, local, private, opt-in semantic)

## 0.2.0 — 2026-09-06
- Embeddings: provider selection `MINDVAULT_EMBEDDINGS_PROVIDER=hash|local|api` — opt-in
  local semantic model via `fastembed` (optional dependency, lazy download, feature-hash
  fallback), https-enforced API; default install unchanged (F3)
- Recall feedback: `accesses` now bumped on every hit + `memory_used` tool; frequency term
  added to the rerank so proven-useful memories surface first (F1)
- Retention: soft size cap `MINDVAULT_MAX_OBS` (default 50k) with lowest-value eviction
  (never explicit/global) + opportunistic prune at `agent_end`; decay now protects
  frequently-recalled memories (F2)
- Chunking: overlap-aware derive-path chunks (~400 chars) keep multi-sentence decisions
  intact; code fences preserved up to 1500 chars instead of truncated to 200 (F4)
- Introspection: `memory_why` (explain a recall), `memory_inspect` (show injected context),
  `memory_edit` (correct a memory in place) (F6)
- Infra: schema migration runner (versioned, transactional) and `PRAGMA busy_timeout=5000`
  for concurrent sessions (F0)

## 0.1.2 — 2026-09-06
- Security: redact auto-capture path (ingest + derive), DB file 0600 / dir 0700,
  `files` allowlist, pinned peer deps, Node >=22.5 floor

## 0.1.1 — 2026-09-06
- Gallery preview image (`preview.png` + `pi.image` metadata)

## 0.1.0 — 2026-09-06
- M1: single-file sqlite (WAL + FTS5), scopes, redaction, 4 pi tools, setup/status commands
- M2: RRF hybrid recall, pluggable embeddings (feature-hash default, API fallback), optional vec0, forget/cascade
- M3: async queue + heuristic Deriver, extractive summaries, 40/60 budgeted context, auto-sync, session delete
- M4: Dreamer (dedupe, decay, card refresh), optimize (checkpoint, FTS rebuild, backfill, prune, vacuum), recall hit-rate, prune commands
