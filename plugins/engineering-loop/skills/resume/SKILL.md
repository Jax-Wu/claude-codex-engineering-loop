---
name: resume
description: Resume an interrupted Claude–Codex engineering loop from persisted project state without duplicating Codex jobs. Use only when the user explicitly invokes /engineering-loop:resume, optionally with approval or resolution text.
---

# Resume Engineering Loop

1. Read `${CLAUDE_PLUGIN_ROOT}/references/orchestration.md` completely.
2. Run the controller `status` command before taking any action.
3. Never create a new run and never start a duplicate Codex task.
4. Resume according to the persisted phase:
   - `PLAN_APPROVAL`: treat `$ARGUMENTS` as approval only when it explicitly approves the displayed plan. Otherwise show the plan and wait.
   - `HUMAN_REQUIRED`: use `$ARGUMENTS` only as an explicit resolution. Do not invent product, migration, security, external-state, or authority decisions.
   - any active execution phase: continue from the exact next action in the orchestration reference.
   - terminal phase: report the terminal result and stop.
5. Continue until the next terminal or waiting state.

Never reset, stash, checkout, or revert files while resuming.
