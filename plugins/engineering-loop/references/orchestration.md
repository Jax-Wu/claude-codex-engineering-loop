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
3. Invoke the `codex:codex-rescue` custom agent with this task:

```text
--wait --fresh
<entire executor packet>
```

The `--wait` and `--fresh` tokens are routing controls for the official agent. Do not call raw Codex CLI or app-server commands.

4. If the agent returns no usable result or reports an invocation failure, mark `HUMAN_REQUIRED`.
5. Write the agent's exact result to `current.executionReportPath` from controller status.
6. Run `execution-complete` with that report path.

## FIXING

1. Generate/read the fix packet:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/controller.mjs" executor-packet --cwd "$PWD" --mode fix
```

2. Invoke `codex:codex-rescue` with:

```text
--wait --resume
<entire fix packet>
```

The explicit continuation language and `--resume` routing control tell the official wrapper to use its latest Codex task for this repository.

3. Write the exact result to `current.executionReportPath`.
4. Run `execution-complete`.

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
