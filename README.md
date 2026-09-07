# pi-mindvault
**A lightweight, private memory extension for [pi](https://github.com/earendil-works/pi-coding-agent) — runs entirely on your machine.**

pi forgets everything the moment a session ends, so you keep re-explaining your stack, your conventions, and decisions you already made. The usual fix is cloud-hosted memory — but that ships your code and context off your machine.

pi-mindvault is the local alternative. It quietly remembers your preferences, decisions, and project facts in a single SQLite file under `~/.pi/memory/`, and feeds the relevant bits back to pi on later turns. No server, no account, no network — your memory never leaves your computer.

> Built on pi's extension API — this is a pi package, not a standalone library. It works with the pi coding agent, not other harnesses.

## Why you'd care
- **Stop repeating yourself.** Tell it "prefer explicit types" or "we deploy on Fridays" once; it resurfaces automatically when it's relevant.
- **Fully local & private.** Everything lives in one file on your disk. Works offline, secrets are redacted before they're stored, and you can delete any memory — or a whole project's — instantly.
- **Lightweight.** Just a SQLite file, no background service. The default needs zero extra downloads and adds no meaningful startup cost.
- **Finds by meaning, not just keywords (opt-in).** Turn on the local semantic model and "how do we handle login?" surfaces "we switched to Clerk for auth" — no shared words required, still 100% on-device.
- **Right memory, right project.** Memories are scoped per directory/repo by default, with a global scope for things true everywhere; one project's notes never bleed into another.
- **You stay in control.** Inspect what it's about to inject, ask why something was recalled, and correct a memory in place.

## Install
Requires pi with extension support and Node 22+.

```bash
pi install npm:@rs25-labs/pi-mindvault
# or from source:
# pi install git:https://github.com/rs25-labs/pi-mindvault
```
Then, inside pi:
```text
/mindvault-setup
```
That creates the local database at `~/.pi/memory/memory.db` and seeds the default scopes. No API key or network required.

## Use
It works automatically: relevant memory is added to the agent's context at the start of each turn, and what you discuss is captured in the background. You can also drive it directly:

```text
remember I always want WAL on as a global rule
search what did we decide about sqlite?
context why did we pick the per-directory default?
forget <id>
memory status
```

Tools (for agents):
- `memory_profile` — instant profile cards, no LLM
- `memory_search` — ranked excerpts `{id, score, source, scope}`
- `memory_context` — the relevant excerpts for a question, with `[id]` cites
- `memory_conclude` — explicitly save a durable fact (wins conflicts, never decays)
- `memory_used` — mark recalled ids that helped (boosts ranking, guards against decay)
- `memory_why` — explain one memory (scope, importance, accesses, last-recall score)
- `memory_inspect` — show exactly what gets injected into the prompt this turn
- `memory_edit` — correct a memory in place (re-index + re-embed)
- `memory_forget` — hard-delete one memory by id

Commands: `/mindvault-setup` (initialize + seed), `/mindvault-config` (embeddings / quiet / maxObs — see below), `/memory` (status), `/dream` (consolidate), `/memory-prune <scope>`.

## Embeddings
The default (`hash`) needs no setup. To change the provider, use `/mindvault-config` — no environment variables required. Settings persist in `~/.pi/memory/config.json`.

```text
/mindvault-config                     # show current config
/mindvault-config embeddings local    # switch to the on-device semantic model
/mindvault-config embeddings hash     # back to the default
```

| Provider | Footprint | Private | Notes |
|----------|-----------|---------|-------|
| `hash` (default) | none, bundled | yes | keyword matching; lexical, fully offline |
| `local` | model (~tens of MB) downloaded on first use to `~/.pi/memory/models` | yes | best recall, offline after download; `fast-bge-small-en-v1.5` (384-dim) |
| `api` | none | no (leaves the machine) | set `url`/`key`/`model`/`dim` under `embeddings` in `config.json` |

`local` uses `fastembed`, installed on demand — run `cd ~/.pi/pi-mindvault && npm install fastembed` if prompted. If the runtime or model is unavailable, recall falls back to keyword mode and keeps working — it never crashes. Switching providers re-embeds your memories lazily.

`/memory` shows which embedder is actually in use, e.g. `emb=local:fast-bge-small-en-v1.5` (semantic model active) or `emb=feature-hash`, with `unavailable→feature-hash` if `local` is selected but the runtime can't load.

## Maintain
- `/memory` shows a quick status line, including recall hit-rate (`recall-hit=82% of 50`).
- `/dream` (or the `memory_optimize` tool) consolidates duplicates, prunes stale memory, and compacts the database. Run it when idle; it can be slow on large vaults.
- Explicit saves and `global` identity facts never decay. Everything else follows a decay policy (stale, low-value, unused memories are pruned), and a size cap keeps the vault fast.

## Privacy
Local-only by default. Secrets and tokens are redacted before storage, and absolute paths outside your working directory are jailed as `<outside-cwd>`. Delete any memory, or a whole scope, at any time.
