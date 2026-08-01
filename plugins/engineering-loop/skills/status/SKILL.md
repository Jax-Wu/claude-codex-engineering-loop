---
name: status
description: Show the active engineering-loop run, phase, round, artifacts, Codex routing metadata, and next safe action. Use only when the user explicitly invokes /engineering-loop:status.
---

# Show Engineering Loop Status

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/controller.mjs" status --cwd "$PWD"
```

Summarize:

- run ID, goal, profile, and phase;
- fix round and configured maximum;
- current plan, report, gates, review packet, verdict, or fix packet paths that exist;
- whether the run is active, waiting for the user, complete, or cancelled;
- exactly one next safe action.

Do not modify state, run gates, invoke Codex, or continue the workflow.
