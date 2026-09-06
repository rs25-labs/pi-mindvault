# pi-mindvault
**Local-first sqlite memory for pi — Hermes durability, Honcho-style recall, no server.**

pi forgets every session. Server memory leaks your code to the cloud. pi-mindvault remembers locally: preferences, decisions, and working rules in a single sqlite file under `~/.pi/memory/memory.db` — WAL-durable like Hermes `state.db`, reasoned like Honcho (peers/sessions/scopes), zero network required.

## Why
- **Never repeat yourself:** save “prefer explicit types” once, it’s injected every turn.
- **Right memory, right repo:** `per-directory` default + `global` for identity. `dir:~/projA` never leaks to `dir:~/projB`.
- **Explicit wins:** corrections via `memory_conclude` supersede forever, never decay.
- **Fast + offline:** cached `peer_cards` pre-turn (0ms), hybrid `vector + FTS5` search, queued writes, fail-open LIKE fallback.
- **Private:** cwd-jail, secret redaction, `forget(id)` + cascade delete, scopes as ACL.

## Install (pi)
```bash
pi install npm:@rs25-labs/pi-mindvault
# or from source:
# pi install git:https://github.com/rs25-labs/pi-mindvault
```
Then in pi:
```text
/mindvault-setup
```
This creates `~/.pi/memory/memory.db` (WAL), `workspace=pi`, peers (`<user>`, `pi-agent`), scopes (`global`, `dir:<cwd>`).

No API key needed for local mode. Optional API embeddings as fallback (pluggable).

## Use
Auto: profile injected pre-turn, messages synced post-turn. Manual:

```text
remember I always want WAL on as global procedural rule
search what did we decide about sqlite-vec?
context why did we pick per-directory default?
forget <id>
memory status
```

Tools (for agents):
- `memory_profile` — instant cards, no LLM
- `memory_search` — raw hybrid excerpts `{id,score,source,scope}`
- `memory_context` — synthesized answer with `[id]` cites
- `memory_conclude` — explicit save (`explicit=1`, wins conflicts)

Config (`recallMode: hybrid|context|tools`, `writeFrequency: async|turn|session|N`, `sessionStrategy: per-directory|per-repo|per-session|global`).

## How it works
- Hermes pattern: single sqlite, WAL, FTS5 external-content + triggers, chunked rebuild, fail-open detach.
- Honcho pattern: `workspace > peers <> sessions > messages`, async Deriver (explicit+deductive) + Dreamer (consolidate, peer cards, session summaries 40/60), RRF `0.6*vector+FTS +0.25*recency+0.15*importance`, scopes filter.
- Types: `episodic / semantic~observations / procedural / working` + `peer_cards` + `summaries`.

## Status
M1 schema+tools → M2 vector+scopes → M3 async+inject → M4 optimize+publish. See `docs/superpowers/specs/2026-09-06-pi-mindvault-prd.md`.

## Privacy
Local-only by default. Redacts tokens/keys, jails outside-cwd paths as `<outside-cwd>`. Delete anytime. Docs/commits never contain absolute paths or usernames (`~/.pi`, `<user>` only).

## M1 scope (this plan)
- FTS5-only search (no vectors yet — M2 adds `sqlite-vec` + RRF).
- `memory_context` is extractive in M1; LLM synthesis lands in M3.
- Queue table exists for M3 workers; M1 writes synchronously.

## M2 scope
- RRF hybrid recall (`vec` + FTS5, recency/importance/explicit rerank); `vec0` when the native extension loads, JS cosine scan otherwise.
- Embeddings pluggable: zero-dep feature-hash default; set `MINDVAULT_EMBEDDINGS_URL/KEY/MODEL/DIM` for API embeddings.
- `memory_forget` + scope delete (session delete lands in M3 with workers).
