import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

export const STATE_DIR_NAME = ".engineering-loop";
export const TERMINAL_STATES = new Set(["DONE", "CANCELLED", "FAILED"]);
export const WAITING_STATES = new Set(["PLAN_APPROVAL", "HUMAN_REQUIRED"]);

export const TRANSITIONS = Object.freeze({
  PREFLIGHT: new Set(["PLANNING", "HUMAN_REQUIRED", "FAILED", "CANCELLED"]),
  PLANNING: new Set([
    "PLAN_APPROVAL",
    "EXECUTING",
    "HUMAN_REQUIRED",
    "FAILED",
    "CANCELLED",
  ]),
  PLAN_APPROVAL: new Set([
    "PLANNING",
    "EXECUTING",
    "HUMAN_REQUIRED",
    "CANCELLED",
  ]),
  EXECUTING: new Set(["VERIFYING", "HUMAN_REQUIRED", "FAILED", "CANCELLED"]),
  VERIFYING: new Set(["REVIEWING", "HUMAN_REQUIRED", "FAILED", "CANCELLED"]),
  REVIEWING: new Set([
    "DONE",
    "FIXING",
    "HUMAN_REQUIRED",
    "FAILED",
    "CANCELLED",
  ]),
  FIXING: new Set(["VERIFYING", "HUMAN_REQUIRED", "FAILED", "CANCELLED"]),
  HUMAN_REQUIRED: new Set([
    "PLANNING",
    "EXECUTING",
    "FIXING",
    "CANCELLED",
    "FAILED",
  ]),
  DONE: new Set(),
  CANCELLED: new Set(),
  FAILED: new Set(),
});

const PROFILE_DEFAULTS = Object.freeze({
  fast: {
    maxFixRounds: 1,
    planApproval: "never",
    blockOnSeverity: "high",
  },
  standard: {
    maxFixRounds: 3,
    planApproval: "risk-based",
    blockOnSeverity: "high",
  },
  strict: {
    maxFixRounds: 3,
    planApproval: "always",
    blockOnSeverity: "medium",
  },
});

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[name] = true;
      continue;
    }
    flags[name] = next;
    index += 1;
  }
  return { flags, positional };
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 15_000,
    maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
    env: options.env ?? process.env,
    shell: false,
  });
  return {
    command: [command, ...args],
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ? String(result.error.message ?? result.error) : null,
    ok: !result.error && result.status === 0,
  };
}

export function findProjectRoot(cwd = process.cwd()) {
  const candidate = resolve(cwd);
  const result = run("git", ["rev-parse", "--show-toplevel"], {
    cwd: candidate,
  });
  if (!result.ok) {
    throw new Error(
      `Not a Git repository: ${candidate}. Start the loop from a Git worktree.`,
    );
  }
  return resolve(result.stdout.trim());
}

export function statePaths(root) {
  const stateDir = join(root, STATE_DIR_NAME);
  return {
    root,
    stateDir,
    activeFile: join(stateDir, "active.json"),
    configFile: join(stateDir, "config.json"),
    runsDir: join(stateDir, "runs"),
  };
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function atomicWriteJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, file);
}

export function atomicWriteText(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, value, "utf8");
  renameSync(temporary, file);
}

export function isInside(root, file) {
  const fromRoot = relative(resolve(root), resolve(file));
  return (
    fromRoot === "" ||
    (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))
  );
}

export function assertInside(root, file, label = "Path") {
  if (!isInside(root, file)) {
    throw new Error(`${label} must stay inside ${root}: ${file}`);
  }
}

export function pathFromRoot(root, file) {
  assertInside(root, file);
  return relative(root, resolve(file)).split(sep).join("/");
}

export function resolveRunArtifact(root, state, artifact) {
  const target = isAbsolute(artifact) ? artifact : join(root, artifact);
  assertInside(join(root, state.runDir), target, "Run artifact");
  return resolve(target);
}

export function filteredGitStatus(root) {
  const result = run(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: root },
  );
  if (!result.ok) {
    throw new Error(`git status failed: ${result.stderr || result.error}`);
  }
  return result.stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .filter((line) => {
      const normalized = line.replaceAll("\\", "/");
      return (
        !normalized.includes(` ${STATE_DIR_NAME}/`) &&
        !normalized.includes(` -> ${STATE_DIR_NAME}/`)
      );
    });
}

export function gitHead(root) {
  const result = run("git", ["rev-parse", "HEAD"], { cwd: root });
  if (!result.ok) {
    throw new Error(`Unable to resolve HEAD: ${result.stderr || result.error}`);
  }
  return result.stdout.trim();
}

export function checkCodexCli(root) {
  const result = run("codex", ["--version"], { cwd: root, timeoutMs: 10_000 });
  return {
    available: result.ok,
    version: result.ok ? result.stdout.trim() : null,
    error: result.ok ? null : result.error || result.stderr.trim() || "not available",
  };
}

export function preflight(root, options = {}) {
  const status = filteredGitStatus(root);
  const codex = options.skipCodexCheck
    ? { available: null, version: null, skipped: true }
    : checkCodexCli(root);
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  const checks = {
    gitRepository: true,
    cleanWorktree: status.length === 0,
    nodeSupported: nodeMajor >= 18,
    codexCliAvailable: codex.available,
  };
  const errors = [];
  if (!checks.nodeSupported) {
    errors.push(`Node.js 18+ is required; found ${process.versions.node}.`);
  }
  if (
    options.requireCleanWorktree !== false &&
    !checks.cleanWorktree
  ) {
    errors.push(
      `The worktree has pre-existing changes: ${status.join(", ")}. Use a clean Desktop worktree or explicitly choose --allow-dirty.`,
    );
  }
  if (!options.skipCodexCheck && !checks.codexCliAvailable) {
    errors.push(
      "Codex CLI is unavailable. Install and authenticate the official codex-plugin-cc dependency, then run /codex:setup.",
    );
  }
  return {
    ok: errors.length === 0,
    root,
    checks,
    codex,
    status,
    errors,
  };
}

export function loadConfig(root, profileName = "standard") {
  if (!Object.hasOwn(PROFILE_DEFAULTS, profileName)) {
    throw new Error(`Unknown profile: ${profileName}`);
  }
  const paths = statePaths(root);
  const project = existsSync(paths.configFile) ? readJson(paths.configFile) : {};
  const profile = {
    ...PROFILE_DEFAULTS[profileName],
    ...(project.profiles?.[profileName] ?? {}),
  };
  const config = {
    schemaVersion: 1,
    profile: profileName,
    requireCleanWorktree: project.requireCleanWorktree ?? true,
    maxFixRounds: project.maxFixRounds ?? profile.maxFixRounds,
    planApproval: project.planApproval ?? profile.planApproval,
    blockOnSeverity: project.blockOnSeverity ?? profile.blockOnSeverity,
    codex: {
      resume: project.codex?.resume ?? true,
      sandbox: project.codex?.sandbox ?? "workspace-write",
    },
    gates: Array.isArray(project.gates) ? project.gates : null,
    limits: {
      maxChangedFiles: project.limits?.maxChangedFiles ?? 30,
      maxDiffLines: project.limits?.maxDiffLines ?? 2500,
      maxPatchBytes: project.limits?.maxPatchBytes ?? 1_000_000,
    },
  };
  if (
    !Number.isInteger(config.maxFixRounds) ||
    config.maxFixRounds < 0 ||
    config.maxFixRounds > 10
  ) {
    throw new Error("maxFixRounds must be an integer between 0 and 10.");
  }
  if (!new Set(["never", "risk-based", "always"]).has(config.planApproval)) {
    throw new Error("planApproval must be never, risk-based, or always.");
  }
  if (
    !new Set(["critical", "high", "medium", "low"]).has(
      config.blockOnSeverity,
    )
  ) {
    throw new Error(
      "blockOnSeverity must be critical, high, medium, or low.",
    );
  }
  if (config.codex.sandbox !== "workspace-write") {
    throw new Error(
      "codex.sandbox must remain workspace-write for implementation runs.",
    );
  }
  for (const [name, value] of Object.entries(config.limits)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`limits.${name} must be a positive integer.`);
    }
  }
  if (config.gates !== null && !Array.isArray(config.gates)) {
    throw new Error("gates must be an array when configured.");
  }
  return config;
}

export function makeRunId(now = new Date()) {
  const stamp = now.toISOString().replaceAll(/[-:.TZ]/gu, "").slice(0, 14);
  return `el-${stamp}-${randomUUID().slice(0, 8)}`;
}

export function recordEvent(state, from, to, note = null) {
  state.events ??= [];
  state.events.push({
    at: new Date().toISOString(),
    from,
    to,
    note,
  });
  state.updatedAt = new Date().toISOString();
}

export function runFile(root, state) {
  return join(root, state.runDir, "run.json");
}

export function writeRun(root, state) {
  atomicWriteJson(runFile(root, state), state);
}

export function readActiveRun(root, options = {}) {
  const paths = statePaths(root);
  if (!existsSync(paths.activeFile)) {
    if (options.allowMissing) {
      return null;
    }
    throw new Error("No active engineering loop exists in this worktree.");
  }
  const active = readJson(paths.activeFile);
  const file = join(root, active.runFile);
  assertInside(paths.runsDir, file, "Active run file");
  if (!existsSync(file)) {
    throw new Error(`Active run points to a missing state file: ${file}`);
  }
  return readJson(file);
}

export function setActiveRun(root, state) {
  const paths = statePaths(root);
  atomicWriteJson(paths.activeFile, {
    runId: state.runId,
    runFile: pathFromRoot(root, runFile(root, state)),
    ownerSessionId: state.ownerSessionId ?? null,
    updatedAt: new Date().toISOString(),
  });
}

export function clearActiveRun(root, state) {
  const paths = statePaths(root);
  if (!existsSync(paths.activeFile)) {
    return;
  }
  const active = readJson(paths.activeFile);
  if (active.runId === state.runId) {
    rmSync(paths.activeFile, { force: true });
  }
}

export function transition(root, state, to, note = null) {
  const allowed = TRANSITIONS[state.status];
  if (!allowed || !allowed.has(to)) {
    throw new Error(`Illegal state transition: ${state.status} -> ${to}`);
  }
  const from = state.status;
  state.status = to;
  recordEvent(state, from, to, note);
  writeRun(root, state);
  if (TERMINAL_STATES.has(to)) {
    clearActiveRun(root, state);
  } else {
    setActiveRun(root, state);
  }
  return state;
}

export function forceHumanRequired(root, state, reason) {
  if (TERMINAL_STATES.has(state.status)) {
    throw new Error(`Cannot pause terminal run ${state.runId} (${state.status}).`);
  }
  if (state.status === "HUMAN_REQUIRED") {
    state.humanReason = reason;
    state.updatedAt = new Date().toISOString();
    writeRun(root, state);
    setActiveRun(root, state);
    return state;
  }
  state.humanReason = reason;
  return transition(root, state, "HUMAN_REQUIRED", reason);
}

export function roundDir(root, state, round = state.fixRound) {
  return join(root, state.runDir, `round-${round}`);
}

export function artifactPaths(root, state) {
  const currentRoundDir = roundDir(root, state);
  return {
    runDir: join(root, state.runDir),
    runFile: runFile(root, state),
    planPath: join(root, state.runDir, "plan.md"),
    executionReportPath: join(
      currentRoundDir,
      state.fixRound === 0 ? "execution-report.md" : "fix-report.md",
    ),
    gatesPath: join(currentRoundDir, "gates.json"),
    patchPath: join(currentRoundDir, "changes.patch"),
    reviewPacketPath: join(currentRoundDir, "review-packet.md"),
    verdictPath: join(currentRoundDir, "verdict.json"),
    fixPacketPath: join(currentRoundDir, "fix-packet.md"),
  };
}

export function summarizeState(root, state) {
  const paths = artifactPaths(root, state);
  return {
    runId: state.runId,
    status: state.status,
    goal: state.goal,
    profile: state.profile,
    fixRound: state.fixRound,
    maxFixRounds: state.maxFixRounds,
    humanReason: state.humanReason ?? null,
    root,
    runDir: paths.runDir,
    planPath: paths.planPath,
    current: paths,
    codex: state.codex,
    updatedAt: state.updatedAt,
  };
}
