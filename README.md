# Claude–Codex Engineering Loop

Claude Code Desktop is the only user interface:

```text
Claude plans → Codex implements → Claude reviews
     ↑                                  │
     └────── Codex repairs on failure ──┘
```

The loop is bounded, persisted in the target repository, and recoverable after an interrupted Desktop session.

## Requirements

- Claude Code Desktop or Claude Code CLI with Node.js 18.18 or newer.
- A clean Git worktree. A dedicated Desktop worktree is recommended.
- OpenAI's official [`codex-plugin-cc`](https://github.com/openai/codex-plugin-cc), with Codex authenticated.

Do not enable the official plugin's global Codex review gate while using this workflow. It implements the opposite review direction and can create nested loops.

## Validate this package

From this marketplace directory:

```bash
npm test
npm run check
claude plugin validate . --strict
claude plugin validate ./plugins/engineering-loop --strict
```

If `claude` is not available in the current shell, run the equivalent commands inside Claude Code:

```text
/plugin validate /absolute/path/to/engineering-loop
/plugin validate /absolute/path/to/engineering-loop/plugins/engineering-loop
```

## Install in Claude Code Desktop

Open a local Code session, then run:

```text
/plugin marketplace add openai/codex-plugin-cc
/plugin marketplace add /absolute/path/to/engineering-loop
/plugin install engineering-loop@engineering-loop-local
/reload-plugins
/codex:setup
```

The first path is the directory containing this README and `.claude-plugin/marketplace.json`.
Installing `engineering-loop` automatically resolves `codex@openai-codex` after both marketplaces have been added. If your Claude Code version predates cross-marketplace dependency resolution, install it manually with `/plugin install codex@openai-codex`.

You can also open the Desktop plugin browser, add the local marketplace, and install both plugins graphically.

## Configure a project

Configuration is optional. Without it, the plugin discovers common `package.json`, Cargo, or Go gates.

For explicit gates, copy:

```text
plugins/engineering-loop/examples/config.json
```

to:

```text
<project>/.engineering-loop/config.json
```

Gate commands must be argv arrays. Shell strings are rejected.

Recommended `.gitignore`:

```gitignore
.engineering-loop/active.json
.engineering-loop/runs/
```

Keep `.engineering-loop/config.json` tracked only if the team wants to share the policy.

## Use it

Start a normal run:

```text
/engineering-loop:start --profile standard Implement refresh-token rotation with replay protection and integration tests
```

Profiles:

- `fast`: low-risk, reversible work; at most one repair round.
- `standard`: risk-based plan approval; at most three repair rounds.
- `strict`: always requires plan approval and blocks medium-severity findings.

If the plan needs approval, inspect it and continue with:

```text
/engineering-loop:resume approve the displayed plan
```

Inspect progress:

```text
/engineering-loop:status
```

Resume after interruption:

```text
/engineering-loop:resume
```

Cancel without reverting any files:

```text
/engineering-loop:cancel
```

### If a command is not recognized

The four entry points ship as skills. A client resolves `/engineering-loop:<name>` against the
plugin registry it snapshotted when its process started, so a plugin installed **after** that point
answers `Unknown command` until the client is restarted — installing, enabling, and validating the
plugin all succeed meanwhile. Confirm with `claude plugin list`, then restart the client process
(not just the conversation). You can also ask for the workflow in prose — "use the engineering-loop
plugin to start a run for …" — which routes through the same skills.

Do not add a `commands/` directory with these names as a workaround: commands and skills share one
namespace, so `commands/start.md` alongside `skills/start/` registers `start` twice and doubles the
always-on context cost.

## End-to-end smoke test

Use a disposable repository or dedicated worktree:

1. Confirm `git status --short` is empty.
2. Run `/codex:setup`.
3. Start:

   ```text
   /engineering-loop:start --profile fast Add a pure function named add(a, b), export it, and add a focused test
   ```

4. In the Desktop task pane, verify that `codex:codex-rescue` runs.
5. Verify `.engineering-loop/runs/<run-id>/` contains:
   - `plan.md`;
   - `executor-packet.md`;
   - `round-0/execution-report.md`;
   - `round-0/gates.json`;
   - `round-0/review-packet.md`;
   - `round-0/verdict.json`.
6. Run `/engineering-loop:status`. The result should be `DONE`, `FIXING`, or a specific `HUMAN_REQUIRED` reason—not an unbounded loop.
7. Check that no commit, push, PR, deployment, or external mutation occurred.

To exercise the repair path, deliberately ask for a testable edge case that the first implementation is likely to omit. A `FIX_REQUIRED` verdict should create `round-1/fix-packet.md`, and the next Codex call should use the official resume path.

## Safety behavior

- The independent reviewer has only `Read`, `Grep`, and `Glob`.
- Required gate failures make PASS invalid.
- Repair rounds are bounded.
- Review size limits pause for a person.
- Dirty worktrees are rejected by default.
- State writes are atomic.
- The Stop hook blocks accidental early completion but allows plan approval and human-decision states.
- The plugin never automatically commits, pushes, opens PRs, deploys, publishes, resets Git, stashes files, or bypasses sandbox protections.

## Troubleshooting

`codex:codex-rescue` is missing:

1. Confirm `codex@openai-codex` is installed and enabled.
2. Run `/reload-plugins`.
3. Run `/codex:setup`.

The loop says the worktree is dirty:

- Start a new Desktop worktree, or cleanly commit your own changes.
- Use `--allow-dirty` only after accepting that review attribution is less reliable.

The Stop hook keeps the session active:

- Run `/engineering-loop:status`.
- Use `/engineering-loop:resume` to continue or `/engineering-loop:cancel` to stop.
- `PLAN_APPROVAL` and `HUMAN_REQUIRED` are waiting states and do not block stopping.

Required gates were not discovered:

- Add explicit argv-array gates to `.engineering-loop/config.json`.

The reviewer returned malformed JSON:

- The workflow retries once. A second invalid response pauses as `HUMAN_REQUIRED`.
