#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  artifactPaths,
  assertInside,
  atomicWriteJson,
  atomicWriteText,
  clearActiveRun,
  findProjectRoot,
  forceHumanRequired,
  gitHead,
  loadConfig,
  makeRunId,
  parseArgs,
  pathFromRoot,
  preflight,
  readActiveRun,
  readJson,
  recordEvent,
  roundDir,
  setActiveRun,
  statePaths,
  summarizeState,
  transition,
  writeRun,
} from "./lib.mjs";
import { validateVerdictObject } from "./validate-verdict.mjs";

const SEVERITY_RANK = Object.freeze({
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
});

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function required(flags, name) {
  const value = flags[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required option --${name}.`);
  }
  return value;
}

function initRun(root, flags) {
  const profile = typeof flags.profile === "string" ? flags.profile : "standard";
  const config = loadConfig(root, profile);
  const allowDirty = flags["allow-dirty"] === true;
  const result = preflight(root, {
    requireCleanWorktree: allowDirty ? false : config.requireCleanWorktree,
    skipCodexCheck: flags["skip-codex-check"] === true,
  });
  if (!result.ok) {
    const error = new Error(result.errors.join(" "));
    error.details = result;
    throw error;
  }
  const existing = readActiveRun(root, { allowMissing: true });
  if (existing) {
    throw new Error(
      `Run ${existing.runId} is already active in this worktree (${existing.status}). Resume or cancel it first.`,
    );
  }
  const runId = makeRunId();
  const paths = statePaths(root);
  const runDirRelative = pathFromRoot(root, join(paths.runsDir, runId));
  const now = new Date().toISOString();
  const state = {
    schemaVersion: 1,
    runId,
    ownerSessionId:
      typeof flags["session-id"] === "string" ? flags["session-id"] : null,
    goal: required(flags, "goal"),
    profile,
    status: "PLANNING",
    baseCommit: gitHead(root),
    baselineStatus: result.status,
    allowDirty,
    config,
    maxFixRounds: config.maxFixRounds,
    fixRound: 0,
    runDir: runDirRelative,
    codex: {
      jobId: null,
      sessionId: null,
      resumeStrategy: "plugin-latest-for-repo",
    },
    artifacts: {},
    humanReason: null,
    createdAt: now,
    updatedAt: now,
    events: [
      {
        at: now,
        from: null,
        to: "PLANNING",
        note: "Preflight passed and run initialized.",
      },
    ],
  };
  writeRun(root, state);
  setActiveRun(root, state);
  return summarizeState(root, state);
}

function makeExecutorPacket(root, state, mode) {
  const paths = artifactPaths(root, state);
  if (!existsSync(paths.planPath)) {
    throw new Error(`Plan does not exist: ${paths.planPath}`);
  }
  const plan = readFileSync(paths.planPath, "utf8");
  let body;
  let target;
  if (mode === "initial") {
    target = join(root, state.runDir, "executor-packet.md");
    body = `# Codex implementation packet

ROLE: You are the implementation owner. Implement the approved plan in the current repository.

GOAL:
${state.goal}

APPROVED PLAN:
${plan}

EXECUTION RULES:
- Implement only the approved scope.
- Preserve pre-existing user changes.
- Follow applicable AGENTS.md instructions.
- Do not commit, push, deploy, publish, or modify external systems.
- Do not reduce sandbox protections.
- Run targeted checks that are safe and already available.
- If the plan is ambiguous, unsafe, or requires scope expansion, stop and report the exact blocker.

FINAL REPORT:
- changed files
- acceptance criteria addressed
- commands run and their results
- deviations and unresolved risks
`;
  } else {
    target = paths.fixPacketPath;
    if (!existsSync(target)) {
      throw new Error(`Fix packet does not exist: ${target}`);
    }
    return target;
  }
  atomicWriteText(target, body);
  state.artifacts.executorPacket = pathFromRoot(root, target);
  writeRun(root, state);
  setActiveRun(root, state);
  return target;
}

function setPlanReady(root, state, flags) {
  if (state.status !== "PLANNING") {
    throw new Error(`Plan can only be recorded from PLANNING, not ${state.status}.`);
  }
  const file = resolve(required(flags, "file"));
  assertInside(join(root, state.runDir), file, "Plan file");
  if (!existsSync(file)) {
    throw new Error(`Plan file does not exist: ${file}`);
  }
  state.artifacts.plan = pathFromRoot(root, file);
  writeRun(root, state);
  const approval =
    typeof flags.approval === "string" ? flags.approval : "required";
  if (!new Set(["required", "skip"]).has(approval)) {
    throw new Error("--approval must be required or skip.");
  }
  return transition(
    root,
    state,
    approval === "required" ? "PLAN_APPROVAL" : "EXECUTING",
    approval === "required"
      ? "Plan is ready and awaits user approval."
      : "Plan approved by the selected profile.",
  );
}

function executionComplete(root, state, flags) {
  if (!new Set(["EXECUTING", "FIXING"]).has(state.status)) {
    throw new Error(
      `Execution can only complete from EXECUTING or FIXING, not ${state.status}.`,
    );
  }
  const paths = artifactPaths(root, state);
  const report = resolve(
    typeof flags["report-file"] === "string"
      ? flags["report-file"]
      : paths.executionReportPath,
  );
  assertInside(join(root, state.runDir), report, "Execution report");
  if (!existsSync(report)) {
    throw new Error(`Execution report does not exist: ${report}`);
  }
  state.artifacts.executionReport = pathFromRoot(root, report);
  if (typeof flags["job-id"] === "string") {
    state.codex.jobId = flags["job-id"];
  }
  if (typeof flags["codex-session-id"] === "string") {
    state.codex.sessionId = flags["codex-session-id"];
  }
  writeRun(root, state);
  return transition(root, state, "VERIFYING", "Codex execution completed.");
}

function gatesPass(root, state) {
  const artifact = state.artifacts.gates;
  if (!artifact) {
    return { ok: false, reason: "No gate evidence has been recorded." };
  }
  const file = join(root, artifact);
  if (!existsSync(file)) {
    return { ok: false, reason: `Gate evidence is missing: ${file}` };
  }
  const gates = readJson(file);
  const failed = (gates.results ?? []).filter(
    (gate) => gate.required && gate.status !== "passed",
  );
  return failed.length === 0
    ? { ok: true, reason: null }
    : {
        ok: false,
        reason: `Required gates failed: ${failed.map((gate) => gate.name).join(", ")}`,
      };
}

function makeFixPacket(root, state, verdict) {
  const target = artifactPaths(root, state).fixPacketPath;
  const issues = verdict.issues
    .filter((issue) => issue.blocking)
    .map(
      (issue) => `## ${issue.id} — ${issue.severity}

- Category: ${issue.category}
- Location: ${issue.file}${issue.line ? `:${issue.line}` : ""}
- Evidence: ${issue.evidence}
- Required fix: ${issue.required_fix}
- Acceptance test: ${issue.acceptance_test}`,
    )
    .join("\n\n");
  const content = `# Codex fix packet

Continue the existing Codex work in this repository.

ROUND: ${state.fixRound} of ${state.maxFixRounds}
GOAL: ${state.goal}

Fix only the blocking findings below. Keep issue IDs in the final response.

${issues}

RULES:
- Make the smallest safe patch.
- Do not refactor unrelated code.
- Preserve all user changes.
- Do not commit, push, deploy, publish, or modify external systems.
- Re-run targeted validation.
- Report issue ID -> files changed -> validation evidence.
`;
  atomicWriteText(target, content);
  state.artifacts.fixPacket = pathFromRoot(root, target);
  return target;
}

function applyVerdict(root, state, flags) {
  if (state.status !== "REVIEWING") {
    throw new Error(`Verdicts are only accepted in REVIEWING, not ${state.status}.`);
  }
  const source = resolve(required(flags, "file"));
  assertInside(join(root, state.runDir), source, "Verdict file");
  const verdict = readJson(source);
  const validation = validateVerdictObject(verdict);
  if (!validation.ok) {
    const error = new Error(`Invalid verdict: ${validation.errors.join(" ")}`);
    error.details = validation;
    throw error;
  }
  const threshold = SEVERITY_RANK[state.config.blockOnSeverity];
  const incorrectlyNonBlocking = verdict.issues.filter(
    (issue) =>
      SEVERITY_RANK[issue.severity] >= threshold && issue.blocking !== true,
  );
  if (incorrectlyNonBlocking.length > 0) {
    throw new Error(
      `Invalid verdict: profile ${state.profile} requires ${state.config.blockOnSeverity}+ issues to block; offending IDs: ${incorrectlyNonBlocking.map((issue) => issue.id).join(", ")}.`,
    );
  }
  const planText = readFileSync(join(root, state.artifacts.plan), "utf8");
  const requiredAcceptance = new Set(planText.match(/\bAC-\d+\b/gu) ?? []);
  const reviewedAcceptance = new Set(
    verdict.acceptance.map((item) => item.id),
  );
  const missingAcceptance = [...requiredAcceptance].filter(
    (id) => !reviewedAcceptance.has(id),
  );
  if (missingAcceptance.length > 0) {
    throw new Error(
      `Invalid verdict: reviewer did not cover acceptance criteria ${missingAcceptance.join(", ")}.`,
    );
  }
  const destination = artifactPaths(root, state).verdictPath;
  atomicWriteJson(destination, verdict);
  state.artifacts.verdict = pathFromRoot(root, destination);

  if (verdict.verdict === "PASS") {
    const gateResult = gatesPass(root, state);
    if (!gateResult.ok) {
      throw new Error(`PASS rejected: ${gateResult.reason}`);
    }
    writeRun(root, state);
    return transition(root, state, "DONE", verdict.summary);
  }

  if (verdict.verdict === "HUMAN_REQUIRED") {
    writeRun(root, state);
    return forceHumanRequired(root, state, verdict.summary);
  }

  if (state.fixRound >= state.maxFixRounds) {
    writeRun(root, state);
    return forceHumanRequired(
      root,
      state,
      `Maximum fix rounds reached. Latest review: ${verdict.summary}`,
    );
  }

  const from = state.status;
  state.fixRound += 1;
  state.status = "FIXING";
  state.humanReason = null;
  recordEvent(
    state,
    from,
    "FIXING",
    `Reviewer requested fix round ${state.fixRound}: ${verdict.summary}`,
  );
  makeFixPacket(root, state, verdict);
  writeRun(root, state);
  setActiveRun(root, state);
  return state;
}

function cancelRun(root, state, reason) {
  if (new Set(["DONE", "CANCELLED", "FAILED"]).has(state.status)) {
    return state;
  }
  const from = state.status;
  state.status = "CANCELLED";
  recordEvent(state, from, "CANCELLED", reason);
  writeRun(root, state);
  clearActiveRun(root, state);
  return state;
}

export function executeController(argv, cwd = process.cwd()) {
  const [command, ...rest] = argv;
  const { flags } = parseArgs(rest);
  const root = findProjectRoot(
    typeof flags.cwd === "string" ? flags.cwd : cwd,
  );

  if (command === "preflight") {
    const profile =
      typeof flags.profile === "string" ? flags.profile : "standard";
    const config = loadConfig(root, profile);
    return preflight(root, {
      requireCleanWorktree:
        flags["allow-dirty"] === true ? false : config.requireCleanWorktree,
      skipCodexCheck: flags["skip-codex-check"] === true,
    });
  }
  if (command === "init") {
    return initRun(root, flags);
  }

  const state = readActiveRun(root);
  if (command === "status" || command === "paths") {
    return summarizeState(root, state);
  }
  if (command === "plan-ready") {
    setPlanReady(root, state, flags);
    return summarizeState(root, state);
  }
  if (command === "approve-plan") {
    transition(root, state, "EXECUTING", "User approved the plan.");
    return summarizeState(root, state);
  }
  if (command === "executor-packet") {
    const mode =
      typeof flags.mode === "string"
        ? flags.mode
        : state.status === "FIXING"
          ? "fix"
          : "initial";
    return { path: makeExecutorPacket(root, state, mode), mode };
  }
  if (command === "execution-complete") {
    executionComplete(root, state, flags);
    return summarizeState(root, state);
  }
  if (command === "verdict") {
    applyVerdict(root, state, flags);
    return summarizeState(root, state);
  }
  if (command === "human") {
    forceHumanRequired(root, state, required(flags, "reason"));
    return summarizeState(root, state);
  }
  if (command === "transition") {
    transition(
      root,
      state,
      required(flags, "to"),
      typeof flags.note === "string" ? flags.note : null,
    );
    return summarizeState(root, state);
  }
  if (command === "cancel") {
    cancelRun(
      root,
      state,
      typeof flags.reason === "string" ? flags.reason : "Cancelled by user.",
    );
    return summarizeState(root, state);
  }
  throw new Error(
    "Unknown command. Use preflight, init, status, paths, plan-ready, approve-plan, executor-packet, execution-complete, verdict, human, transition, or cancel.",
  );
}

function main() {
  try {
    print(executeController(process.argv.slice(2)));
  } catch (error) {
    print({
      ok: false,
      error: error.message,
      details: error.details ?? null,
    });
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
