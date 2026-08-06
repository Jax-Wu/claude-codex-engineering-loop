---
name: resume
description: Resume an interrupted Claude–Codex engineering loop from persisted project state without duplicating Codex jobs. Use only when the user explicitly invokes /engineering-loop:resume, optionally with approval or resolution text.
---

# Resume Engineering Loop

1. Read `${CLAUDE_PLUGIN_ROOT}/references/orchestration.md` completely.
2. Run the controller `status` command before taking any action.
3. Never create a new run and never start a duplicate Codex task. Use `${CLAUDE_PLUGIN_ROOT}/scripts/codex-dispatch.mjs` to poll or recover the recorded job before dispatching anything; `lease --cwd "$PWD"` shows whether a job still holds the worktree. Re-dispatching is safe only with the same `--attempt` string the interrupted phase used, which is why it is derived from `runId`, phase, and `fixRound` rather than generated.
4. Resume according to the persisted phase:
   - `PLAN_APPROVAL`: treat `$ARGUMENTS` as approval only when it explicitly approves the displayed plan. Otherwise show the plan and wait.
   - `HUMAN_REQUIRED`: use `$ARGUMENTS` only as an explicit resolution. Do not invent product, migration, security, external-state, or authority decisions.
   - any active execution phase: continue from the exact next action in the orchestration reference.
   - terminal phase: report the terminal result and stop.
5. Continue until the next terminal or waiting state.

Never reset, stash, checkout, or revert files while resuming.
