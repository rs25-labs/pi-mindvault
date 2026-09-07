# Changelog

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
