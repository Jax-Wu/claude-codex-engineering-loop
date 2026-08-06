# openai-codex 1.0.4 — stale-job guard

A local patch to the installed `codex@openai-codex` plugin. It makes a companion
job record that has stopped being updated say so, instead of reporting `running`
forever.

## What broke, and why a patch exists at all

On 2026-08-03 an engineering-loop run appeared to hang three times, for 15, 34
and 22 minutes. The rollout files under `~/.codex/sessions/` later showed at
least two of those Codex turns had finished normally minutes before anyone
cancelled them. Nothing hung. What actually happened:

- the foreground reader was SIGTERMed at exactly 10 minutes (exit 143);
- `runTrackedJob` writes `running` *before* awaiting the turn and writes the
  terminal state only *after* the await returns — so killing the writer leaves
  the record on `running` permanently;
- `createJobProgressUpdater` wrote nothing at all for events that did not change
  phase / thread / turn, so a live job and an abandoned record were byte-identical
  on disk;
- nothing anywhere checked how old a `running` record was.

The operator saw three hangs and wrote three hangs into the DEVLOG. The wrong
diagnosis survived three days. Full evidence with file:line citations:
`~/FundaTasks/Data-Infra/LOOP-DIAGNOSIS.md`.

## The change

Three files under `scripts/lib/`:

| file | change |
|---|---|
| `tracked-jobs.mjs` | every progress event refreshes `lastEventAt` (5s throttle), so silence is visible on disk |
| `stale-jobs.mjs` | **new** — classifies active job records by last-activity age; 10-minute threshold |
| `render.mjs` | `status` output prints the warning for stale records |

Reporting only. It never cancels a job, never mutates a record, and never
concludes the job is dead — a stale *record* and a dead *job* are different
claims, and conflating them is what produced the original wrong diagnosis.

Reproduce the diff at any time:

```bash
diff -u baseline/tracked-jobs.mjs patched/tracked-jobs.mjs
diff -u baseline/render.mjs patched/render.mjs
```

`baseline/` is upstream `openai/codex-plugin-cc` at `807e03a` (plugin 1.0.4),
verified byte-identical to the marketplace clone. Apache-2.0; `patched/` are
modified copies of those files.

## Replaying it

`~/.claude/plugins/cache/` is Claude Code's, not ours. A `/plugin` update to
`codex` replaces the whole version directory and the guard goes with it, silently.

```bash
node apply.mjs           # check only, exit 0 iff installed and current
node apply.mjs --apply   # install
```

`apply.mjs` resolves the target from `installed_plugins.json`, gates every write
on a sha256 match against either the 1.0.4 baseline or our patched copy, and
**refuses** on anything else. If upstream ships 1.0.5, the refusal is correct
behaviour: re-derive the change against the new baseline and regenerate
`manifest.json`, rather than pushing 1.0.4 code over a newer file.

Replay is manual and there is no watcher. Run the check after any `codex` plugin
update, or when companion `status` stops showing the stale warning you expect.

Tests live at `tests/stale-jobs.test.mjs` in this repo and import `patched/`
directly, so `npm test` covers the logic whether or not it is installed anywhere.

## Why not upstream

Sending this to `openai/codex-plugin-cc` was considered and rejected as the
*survival* mechanism. It is someone else's repo: whether it lands, when, and in
what shape is not ours to decide, and the justification is a private incident
whose evidence (rollout files, a local DEVLOG) cannot be attached to a public PR.
Depending on it would mean the guard's survival hinges on a decision we do not
control. Offering it upstream later remains fine — as a separate choice, not as
this one.
