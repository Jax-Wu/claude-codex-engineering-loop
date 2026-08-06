# Orchestration Procedure

Follow the persisted state, not memory. Run all scripts from the target Git worktree. Use `node "${CLAUDE_PLUGIN_ROOT}/scripts/<name>.mjs"`.

## PLANNING

1. Inspect the repository and applicable `CLAUDE.md` and `AGENTS.md` files.
2. Read `planning-contract.md`.
3. Use the controller `status` output to obtain `planPath`.
4. Write the plan to that exact path with stable acceptance IDs (`AC-001`, ...).
5. Require plan approval when:
   - profile is `strict`;
   - the task affects auth, payments, permissions, migrations, infrastructure, public APIs, destructive behavior, external systems, or sensitive data;
   - the plan contains an unresolved decision.
6. For `standard`, skip approval only for clearly bounded, reversible, low-risk work. For `fast`, still require approval for the high-impact categories above.
7. Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/controller.mjs" plan-ready --cwd "$PWD" --file "<planPath>" --approval required
```

Use `--approval skip` only when the rules above permit it.

If status becomes `PLAN_APPROVAL`, show the plan and wait. Do not use a Stop hook to auto-approve.

## PLAN_APPROVAL

Proceed only after explicit user approval of the displayed plan:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/controller.mjs" approve-plan --cwd "$PWD"
```

If the user requests plan changes, transition back to `PLANNING` with a note, revise the plan, and request approval again.

## EXECUTING

1. Generate the initial packet:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/controller.mjs" executor-packet --cwd "$PWD" --mode initial
```

2. Read the returned packet.
3. Dispatch it through the native detached companion:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-dispatch.mjs" dispatch --cwd "$PWD" --mode fresh --prompt-file "<executorPacketPath>" --attempt "<runId>:EXECUTING:round-<fixRound>"
```

Record the returned `jobId`, `threadId`, `turnId`, and receipt path. Before returning, the helper atomically stores the exact mapping under `~/.codex/engineering-loop/receipts`, outside companion-managed state. The helper uses the official companion's background mode; do not call raw Codex CLI or app-server commands. A foreground `--wait` is stripped before it reaches the companion and only exposes the reader to a 10-minute kill.

Build `--attempt` from controller status only — `runId`, the phase, and `fixRound` — so the identical retry produces the identical string. Never add a timestamp, counter, or random suffix: the whole guard depends on a retry being recognisable as the same attempt. `reused: true` in the output means the job already existed and nothing new was started; treat it exactly like the original dispatch and go straight to polling.

Before dispatching, the helper claims a write lease on the worktree. See [Workspace write lease](#workspace-write-lease) for what exit `6` means and what to do about it. Do not work around a refusal by inventing a new attempt id.

Before dispatch, choose model and effort according to the executor contract's [Model and effort](executor-contract.md#model-and-effort) guidance. If either setting is omitted, it inherits the machine's global Codex configuration.

4. Poll with short calls until the exit code reports a terminal job:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-dispatch.mjs" poll --job "<jobId>"
```

Exit `3` means the job is still active, exit `4` means to follow stalled-job recovery below, exit `5` means the job is terminal without a result, and exit `0` means the companion recorded completion.

5. Retrieve the report:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-dispatch.mjs" result --job "<jobId>"
```

`result` exits `0` only with a usable report. It exits `5` with `report: null` for an unknown, missing, or ambiguous recovery target; exit `2` is a usage error.

6. If neither the companion nor exact rollout recovery returns a usable `report`, mark `HUMAN_REQUIRED`.
7. Write the exact `report` string to `current.executionReportPath` from controller status.
8. Run `execution-complete` with that report path and the returned job and thread IDs.

## FIXING

1. Generate/read the fix packet:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/controller.mjs" executor-packet --cwd "$PWD" --mode fix
```

2. Dispatch the complete fix packet as a fresh detached job:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-dispatch.mjs" dispatch --cwd "$PWD" --mode fresh --prompt-file "<fixPacketPath>" --attempt "<runId>:FIXING:round-<fixRound>"
```

The fix packet and current worktree provide the continuation context. Never use `--resume` after an interruption or cancel: it yields `thread not found` and stalls at phase `starting`. `fixRound` advances per repair round, so each round is a distinct attempt and takes the lease from the previous one once that job is terminal.

3. Poll the job and retrieve its result with the same `poll` and `result` commands used in `EXECUTING`.
4. Write the exact returned `report` string to `current.executionReportPath`.
5. Run `execution-complete` with the returned job and thread IDs.

### Workspace write lease

One worktree holds one write-capable Codex job at a time, enforced by an
O_EXCL claim under `~/.codex/engineering-loop/leases`, not by this document.

`dispatch` exits `6` and starts nothing when the lease is held. Read `reason`:

- `workspace-lease-held` — another attempt's job is still active. Poll or recover
  that job (`poll --job`, then `result --job`) and let it finish. Two
  write-capable jobs in one worktree interleave edits and the result is not
  reviewable.
- `workspace-lease-unverifiable` — the holding job left no companion state and no
  recoverable rollout, so it cannot be *shown* to have finished. This refuses on
  purpose. "No record" is not "dead" — that inversion is what produced the
  2026-08-03 misdiagnosis.
- `attempt-claimed-without-job` — a previous dispatch of this same attempt died
  between claiming the lease and recording a job. It may have launched one.
- `workspace-lease-invalid` / `workspace-lease-raced` — unreadable lease file, or
  another dispatch claimed the workspace in the same instant.

Inspect without changing anything:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-dispatch.mjs" lease --cwd "$PWD"
```

Release only after establishing that no job is writing — a `result` that returns
a report, or a `poll` that reports terminal:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-dispatch.mjs" release --cwd "$PWD"
```

A terminal holder is reclaimed automatically on the next dispatch; `release` is
for the cases the helper cannot verify. It is a human decision. Do not call it to
clear a refusal you have not diagnosed, and never respond to exit `6` by
generating a different attempt id.

### Stalled-job recovery

Do not cancel a job merely because its log stopped. Use the log's last-event timestamp as the liveness signal: healthy turns have observed gaps no longer than about 69 seconds, while more than 120 seconds at phase `running` means "no reader attached," not "dead."

Before cancelling, run `result --job <id>`. It checks companion state, then the independently stored receipt, and uses the exact thread and turn mapping to find `payload.type == "task_complete"` in the rollout. The returned `payload.last_agent_message` is the execution report.

If the job state and receipt are both gone but the exact thread ID is known, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-dispatch.mjs" result --thread "<threadId>"
```

A rollout with multiple `task_complete` events is ambiguous without an exact turn ID; rerun with `--turn "<turnId>"`. A legacy job ID with neither state nor a receipt can only produce timestamp-based `discoveryHints` and always returns `report: null` with exit `5`. Use a hint only to locate identifiers for an explicit thread/turn request. Never select a report by job timestamp, repository/time proximity, or newest rollout. Only cancel after exact recovery confirms that no matching `task_complete` exists.

## VERIFYING

Run deterministic gates:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/run-gates.mjs" --cwd "$PWD"
```

Do not hide failures. The script transitions the run to `REVIEWING` even when required gates fail so the reviewer can create actionable findings.

## REVIEWING

1. Collect evidence:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/collect-evidence.mjs" --cwd "$PWD"
```

If it returns `humanRequired: true`, stop and report the limit.

2. Invoke `engineering-loop:engineering-reviewer` with only:

```text
Read <reviewPacketPath>, inspect referenced changed files as needed, and return the required raw JSON verdict.
```

3. Write the raw agent response to `verdictPath`.
4. Validate it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-verdict.mjs" "<verdictPath>"
```

If invalid, give the validation errors to the same reviewer once and ask for corrected raw JSON. If the second response is invalid, mark `HUMAN_REQUIRED`.

5. Apply it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/controller.mjs" verdict --cwd "$PWD" --file "<verdictPath>"
```

The controller rejects PASS when required gates failed. It transitions a valid `FIX_REQUIRED` result to `FIXING`, increments the bounded round, and creates the next fix packet.

## DONE

Report:

- approved plan path;
- changed files;
- required gate results;
- review/fix rounds;
- remaining non-blocking risks;
- that no commit, push, PR, deployment, or external mutation was performed.

## HUMAN_REQUIRED

Show the exact persisted reason and the relevant artifact paths. Ask for the specific missing decision. Do not broaden authority from a vague "continue."

After the user resolves the issue:

- return to `PLANNING` for plan or scope changes;
- return to `EXECUTING` only when no implementation has begun;
- return to `FIXING` only when a valid fix packet exists.

Use the controller `transition` command with a note that records the user's decision.

## Failure rules

- Never exceed `maxFixRounds`.
- Never run two Codex jobs for the same phase attempt.
- Never enable the official plugin's global review gate during this workflow.
- Never use bypass-permission or danger-full-access modes.
- Never modify, stash, reset, or revert pre-existing user changes.
- Never automatically commit, push, create a PR, deploy, publish, or apply a production migration.
