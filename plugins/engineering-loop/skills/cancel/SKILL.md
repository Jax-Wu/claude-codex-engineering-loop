---
name: cancel
description: Cancel the active engineering-loop run while preserving every code and user change. Use only when the user explicitly invokes /engineering-loop:cancel.
---

# Cancel Engineering Loop

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/controller.mjs" cancel --cwd "$PWD" --reason "Cancelled by user."
```

Report the cancelled run ID and its artifact directory.

Do not cancel Codex globally, delete artifacts, reset Git, stash changes, revert files, or remove the run directory. If a Codex background job is still active, tell the user its job ID when known and ask whether they also want to cancel that official-plugin job.
