# openai-codex 1.0.4 — state integrity

A local patch to `scripts/lib/state.mjs` in the installed `codex@openai-codex`
plugin. It stops the companion's job records from being lost quietly.

## What was wrong

Root cause #5 in `~/FundaTasks/Data-Infra/LOOP-DIAGNOSIS.md`. Three defects that
individually look survivable and together destroy data:

| | before |
|---|---|
| `saveState` | plain `writeFileSync` — a crash mid-write leaves a truncated `state.json` |
| `loadState` | `catch { return defaultState() }` — that truncated file reads back as "no jobs have ever run" |
| `updateState` | unlocked read-modify-write — two processes each read, each add a job, each write back without the other's |

The chain is the problem. A torn write becomes empty state, and the next
`updateState` persists that emptiness — an index containing one job where there
were fifty, with no error anywhere. The 08-03 evidence includes a job whose own
file said `failed` while the state index said `cancelled`, which is what a
racing pair of writers to two stores looks like.

## The change

- **`writeFileAtomic`** — temp file, `fsync`, `rename` over the destination.
  Rename is atomic within a directory, so a reader sees the whole old file or the
  whole new one. Used by `saveState` and `writeJobFile`.
- **`loadState` quarantines and throws** — unparseable JSON (or a non-object
  top level) is renamed to `state.json.corrupt-<timestamp>` and the caller gets a
  loud error naming both paths. It self-heals: the next call starts from empty
  state, but a human saw the error and the bytes are still there.
- **A lock around read-modify-write** — `mkdir` on `.state.lock`, which either
  creates or fails `EEXIST` atomically. Reentrant by depth, since `updateState`
  calls `saveState`. A holder older than 30s is treated as crashed and reclaimed,
  so a killed process cannot wedge every later write. Waiting times out after 10s
  with a message naming the lock directory.

`writeJobFile` deliberately takes no lock: each job file has one writer and is
not read-modify-write. It only needs the atomic replace.

One behavioural change worth knowing: files written through the temp path get
mode `0600` rather than the umask default. Same user, stricter.

Reproduce the diff:

```bash
diff -u baseline/state.mjs patched/state.mjs
```

`baseline/` is upstream `openai/codex-plugin-cc` at `807e03a` (plugin 1.0.4),
verified byte-identical to the marketplace clone. Apache-2.0.

## What this does NOT fix

- `session-lifecycle-hook.mjs` still does its own `loadState` → filter →
  `saveState` without holding the lock across both. The write is now atomic, but
  the read-modify-write window remains. Patching it means patching a second file
  and was left out deliberately.
- SessionEnd still deletes every job belonging to the session, completed ones
  included, rather than keeping terminal tombstones. Engineering-loop no longer
  depends on that surviving — it writes its own receipts under
  `~/.codex/engineering-loop/receipts` — so this was not worth a third patched
  file.
- The unbounded waits in `lib/app-server.mjs` and `lib/codex.mjs` are untouched.
  Those are the remaining genuine-hang risk, and the right fix is an inactivity
  timeout that terminalizes the job — a real design change inside a 1088-line
  third-party file, not a patch to carry locally.

## Replaying it

```bash
node apply.mjs           # check only, exit 0 iff installed and current
node apply.mjs --apply   # install
```

Same rules as the sibling patch: the target comes from `installed_plugins.json`,
every write is gated on a sha256 match against either the 1.0.4 baseline or our
patched copy, and anything else is refused rather than overwritten. `npm run
patch:check` at the repo root checks every bundle under `patches/`.

Tests are at `tests/state-integrity.test.mjs`. They import `patched/state.mjs`
into a sandbox with a stubbed `workspace.mjs`, so `npm test` covers the logic
whether or not the patch is installed anywhere.

## Why not upstream

Same reasoning as the stale-guard patch: it is OpenAI's repository, acceptance is
not ours to decide, and the justification rests on private rollout evidence. This
one is also more invasive — it changes the write path every companion command
depends on — which is a further argument for proving it locally first rather than
making its survival depend on someone else's review queue.
