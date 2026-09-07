# pi-mindvault
**A lightweight, private memory for your AI coding agent — runs entirely on your machine.**

Coding agents forget everything the moment a session ends, so you keep re-explaining your stack, your conventions, and decisions you already made. The usual fix is cloud-hosted memory — but that ships your code and context off your machine.

pi-mindvault is the local alternative. It quietly remembers your preferences, decisions, and project facts in a single SQLite file under `~/.pi/memory/`, and feeds the relevant bits back to the agent on later turns. No server, no account, no network — your memory never leaves your computer.

## Why you'd care
- **Stop repeating yourself.** Tell it "prefer explicit types" or "we deploy on Fridays" once; it resurfaces automatically when it's relevant.
- **Fully local & private.** Everything lives in one file on your disk. Works offline, secrets are redacted before they're stored, and you can delete any memory — or a whole project's — instantly.
- **Lightweight.** Just a SQLite file, no background service. The default needs zero extra downloads and adds no meaningful startup cost.
- **Finds by meaning, not just keywords (opt-in).** Turn on the local semantic model and "how do we handle login?" surfaces "we switched to Clerk for auth" — no shared words required, still 100% on-device.
- **Right memory, right project.** Memories are scoped per directory/repo by default, with a global scope for things true everywhere; one project's notes never bleed into another.
- **You stay in control.** Inspect what it's about to inject, ask why something was recalled, and correct a memory in place.

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

Config (`recallMode: hybrid|context|tools`, `writeFrequency: async|turn|session|N`, `sessionStrategy: per-directory|per-repo|per-session|global`). Set `MINDVAULT_QUIET=1` to suppress the passive per-session status banner.

## Embeddings
Recall quality depends on the embedding provider, selected with `MINDVAULT_EMBEDDINGS_PROVIDER`:

| Provider | Footprint | Private | Notes |
|----------|-----------|---------|-------|
| `hash` (default) | none, bundled | yes | zero-dependency feature-hash; lexical, offline |
| `local` | model (~23MB+) downloaded on first use; runtime is an optional dependency | yes | best recall, offline; set `MINDVAULT_EMBEDDINGS_MODEL` |
| `api` | none | no (leaves the machine) | set `MINDVAULT_EMBEDDINGS_URL` (https), `_KEY`, `_MODEL`, `_DIM` |

`local` uses `fastembed` (declared under `optionalDependencies`, so a default install pulls nothing extra). If the runtime or model is unavailable, embeddings fall back to `hash` and recall keeps working. Switching providers re-embeds lazily; new writes embed asynchronously (the Deriver/optimize path), so vector recall for a just-written memory is eventually consistent while FTS covers it immediately.

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

## M3 scope
- Async ingest: turns buffered to `messages` + queue; heuristic Deriver (no LLM) extracts `episodic` facts; poison jobs fail after 3 attempts.
- Extractive session summaries + 40/60 budgeted prompt context; post-turn auto-sync (bounded, best-effort).
- Session lifecycle helpers + cascade delete. LLM-backed Deriver/Dreamer stay M4.

## Maintain
- `memory_optimize` tool (or run `dream` / `memory-prune <scope>` commands): checkpoint + FTS rebuild + backfill + Dreamer + expiry prune + vacuum. Slow on large DBs — run idle.
- `/memory` shows recall hit-rate (`recall-hit=82% of 50`) to tune thresholds.
- Explicit memories and `global` identity facts never decay; everything else follows the 30-day low-importance episodic policy.

## Install for real
```bash
pi install npm:@rs25-labs/pi-mindvault
```
Then `/mindvault-setup` inside pi. Requires pi with extension support and Node 22+.

## Releasing (maintainers)
First publish must be manual (tokens/CLI cannot complete it): publish `0.1.0` publicly
via staged publish + browser approval. Only then does the package get a Settings page.
Trusted Publisher (OIDC) is configured on the *package* Settings page — not account
settings, which has no such option. Add repo `rs25-labs/pi-mindvault`, workflow
`publish.yml`. After that, every release is just a `v*` tag; the Action tests,
typechecks, and publishes with provenance. No tokens involved.
