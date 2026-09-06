# Changelog

## 0.1.1 — 2026-09-06
- Gallery preview image (`preview.png` + `pi.image` metadata)

## 0.1.0 — 2026-09-06
- M1: single-file sqlite (WAL + FTS5), scopes, redaction, 4 pi tools, setup/status commands
- M2: RRF hybrid recall, pluggable embeddings (feature-hash default, API fallback), optional vec0, forget/cascade
- M3: async queue + heuristic Deriver, extractive summaries, 40/60 budgeted context, auto-sync, session delete
- M4: Dreamer (dedupe, decay, card refresh), optimize (checkpoint, FTS rebuild, backfill, prune, vacuum), recall hit-rate, prune commands
