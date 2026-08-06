# Codex Executor Contract

Codex owns implementation and repair.

Every packet must state the goal, approved plan or blocking findings, repository constraints, validation expectations, and prohibited external actions.

Use `scripts/codex-dispatch.mjs` for every Codex handoff:

- dispatch initial work and repairs in native background mode with `dispatch --cwd <repo> --mode fresh --prompt-file <packet> --attempt <id>`;
- poll the returned job ID with `poll --job <id>`;
- retrieve the final report with `result --job <id>`;
- recover a known rollout directly with `result --thread <id>`, adding `--turn <id>` when the rollout contains more than one completed turn;
- inspect or hand back the worktree's write lease with `lease --cwd <repo>` and `release --cwd <repo>`.

`--attempt` identifies the phase attempt, never the job. Derive it from controller status alone (`runId`, phase, `fixRound`) so a retry produces the same string, and re-dispatching returns the existing job with `reused: true` instead of starting a second one. A timestamp or random suffix defeats the guard entirely.

Exactly one write-capable job per worktree is enforced by an O_EXCL lease claim, not by this contract's wording — the 2026-08-03 double dispatch happened while the wording already said "exactly one". `dispatch` exits `6` without launching anything when another attempt holds the lease, and refuses rather than guessing when the holder's fate cannot be established. Never answer exit `6` by changing the attempt id.

The helper launches the official companion as a detached, write-capable task and returns without waiting for the turn. Before returning, it atomically writes an independent job-to-thread receipt under `~/.codex/engineering-loop/receipts`. The receipt records the exact job, thread, turn, workspace, and dispatch timestamp, and is not stored in companion-managed state.

Do not route execution through a foreground `codex:codex-rescue` agent: `--wait` is stripped before it reaches the companion and only buys a 10-minute foreground kill. Never use `--resume` after an interruption or cancel; it yields `thread not found` and stalls at phase `starting`. Dispatch a fresh job with the complete packet instead.

`result` returns exit `0` only when it emits a usable report. It returns exit `5` with `report: null` when the identifier is unknown, the rollout or turn is missing, or recovery is ambiguous. Missing or conflicting selector options are usage errors and return exit `2`. A pruned legacy job with no receipt may produce timestamp-based `discoveryHints`, but those hints never select or return a report; rerun with an exact thread ID and, when required, an exact turn ID. Never infer a result from job timestamp, workspace/time proximity, or the newest rollout.

Preserve the helper result's exact `report` string as the execution report. Do not paraphrase it before evidence collection.

If Codex reports ambiguity, missing authority, destructive work, secrets, external writes, or an incompatible plan, pause the loop. Claude must not fill in the decision on Codex's behalf.

## Model and effort

`--model` and `--effort` are both unset by default. When omitted, they inherit the machine's global Codex configuration; the engineering loop does not pin either setting. Accepted `--effort` values are `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`. Explicit model and effort values pass through rescue-agent routing unchanged; only `--wait`, `--background`, `--fresh`, and `--resume` are stripped.

Choose effort for the shape of each dispatch:

- use lower effort for bounded mechanical work whose method is already known, such as renaming, rewording documentation, adding a flag, or applying a known patch;
- keep the high end for design or diagnosis work where the reasoning or plan is itself the deliverable;
- use lower effort for repair rounds when an independent reviewer has already localised the defect: the finding contains the main diagnostic work. Raise it only if the repair exposes a broader or ambiguous problem.

Effort is also a reliability choice. Higher effort can produce longer turns, and longer turns are more likely to outlive the foreground reader, after which events may be dropped and the job record may remain stuck at `running`. Select effort deliberately rather than inheriting it by accident.
