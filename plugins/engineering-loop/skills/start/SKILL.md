---
name: start
description: Start a bounded Claude-plan, Codex-implement, Claude-review, Codex-repair engineering workflow. Use only when the user explicitly invokes /engineering-loop:start with a concrete software-engineering goal.
---

# Start Engineering Loop

Use `$ARGUMENTS` as the complete task request. If it is empty or lacks a concrete outcome, ask for the missing goal and do not create a run.

1. Read `${CLAUDE_PLUGIN_ROOT}/references/orchestration.md` completely.
2. Parse an optional leading `--profile fast|standard|strict`; default to `standard`. Treat the remaining text as the goal.
3. Run the controller `preflight` command from the selected project folder.
4. Verify the `codex:codex-rescue` custom agent is available. If it is unavailable, tell the user to install OpenAI's `codex-plugin-cc`, reload plugins, and run `/codex:setup`. Do not substitute raw Codex CLI calls.
5. Initialize the run with the controller. Never pass `--allow-dirty` unless the user explicitly requested it after seeing the dirty-worktree warning.
6. Follow the orchestration reference from the returned `PLANNING` state until the run reaches `DONE`, `PLAN_APPROVAL`, `HUMAN_REQUIRED`, `FAILED`, or `CANCELLED`.

Do not implement business code yourself while the run is active. Claude owns planning, orchestration, evidence collection, and review; Codex owns implementation and repair.
