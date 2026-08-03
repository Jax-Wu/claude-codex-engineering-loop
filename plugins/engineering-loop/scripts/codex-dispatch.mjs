#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const EXIT = Object.freeze({ ERROR: 1, USAGE: 2, ACTIVE: 3, DETACHED: 4, NO_RESULT: 5 });
const ACTIVE = new Set(["queued", "running"]);
const SAFE_JOB_ID = /^[a-zA-Z0-9._-]+$/u;
const TIMESTAMPED_JOB_ID = /^task-([a-z0-9]+)-[a-z0-9]+$/iu;
const ROLLOUT_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const DISCOVERY_WINDOW_MS = 5 * 60 * 1000;

class UsageError extends Error {}

function usage() {
  console.log(`Usage:
  node scripts/codex-dispatch.mjs dispatch --cwd <repo> --mode fresh --prompt-file <path>
  node scripts/codex-dispatch.mjs poll --job <id>
  node scripts/codex-dispatch.mjs result --job <id> [--turn <id>]
  node scripts/codex-dispatch.mjs result --thread <id> [--turn <id>]

Exit codes: 0 result recovered, 1 runtime error, 2 usage error,
3 poll reports active, 4 poll reports likely detached, 5 no unambiguous result.`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new UsageError(`Unexpected argument: ${token}`);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new UsageError(`Missing value for ${token}.`);
    const name = token.slice(2);
    if (Object.hasOwn(options, name)) throw new UsageError(`Option ${token} was provided more than once.`);
    options[name] = value;
    index += 1;
  }
  return { command, options };
}

function allowOnly(options, allowed) {
  for (const name of Object.keys(options)) {
    if (!allowed.has(name)) throw new UsageError(`Unknown option --${name}.`);
  }
}

function required(options, name) {
  const value = options[name];
  if (!value) throw new UsageError(`Missing required option --${name}.`);
  return value;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function noResult(value) {
  print({ source: null, report: null, ...value });
  process.exitCode = EXIT.NO_RESULT;
}

function findCompanion() {
  const override = process.env.CODEX_COMPANION_PATH;
  if (override && existsSync(override)) return override;
  const root = join(homedir(), ".claude", "plugins", "cache", "openai-codex", "codex");
  const versions = existsSync(root)
    ? readdirSync(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    : [];
  for (const version of versions) {
    const candidate = join(root, version, "scripts", "codex-companion.mjs");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Codex companion not found. Install codex-plugin-cc and run /codex:setup.");
}

function runCompanion(args, options = {}) {
  return spawnSync(process.execPath, [findCompanion(), ...args], {
    encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...options,
  });
}

function stateRoots() {
  const roots = [join(tmpdir(), "codex-companion")];
  if (process.env.CLAUDE_PLUGIN_DATA) roots.unshift(join(process.env.CLAUDE_PLUGIN_DATA, "state"));
  const pluginData = join(homedir(), ".claude", "plugins", "data");
  if (existsSync(pluginData)) {
    for (const entry of readdirSync(pluginData, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(join(pluginData, entry.name, "state"));
    }
  }
  return [...new Set(roots)];
}

function locateJobs(jobId) {
  if (!SAFE_JOB_ID.test(jobId)) return [];
  const found = [];
  for (const stateRoot of stateRoots()) {
    if (!existsSync(stateRoot)) continue;
    for (const entry of readdirSync(stateRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const jobFile = join(stateRoot, entry.name, "jobs", `${jobId}.json`);
      if (existsSync(jobFile)) {
        found.push({ job: JSON.parse(readFileSync(jobFile, "utf8")), stateRoot });
      }
    }
  }
  return found;
}

function findJob(jobId) {
  if (!SAFE_JOB_ID.test(jobId)) throw new UsageError("Invalid job id.");
  const found = locateJobs(jobId);
  if (found.length === 0) throw new Error(`No companion state found for job ${jobId}.`);
  if (found.length > 1) throw new Error(`Ambiguous companion state found for job ${jobId}.`);
  return found[0];
}

function lastLogEvent(logFile) {
  if (!logFile || !existsSync(logFile)) return { at: null, seconds: null };
  const text = readFileSync(logFile, "utf8");
  const matches = [...text.matchAll(/^\[([^\]]+)\]/gmu)];
  const at = matches.at(-1)?.[1] ?? null;
  const time = Date.parse(at ?? "");
  return {
    at,
    seconds: Number.isFinite(time) ? Math.max(0, Math.floor((Date.now() - time) / 1000)) : null,
  };
}

function companionEnv(stateRoot) {
  const env = { ...process.env };
  const fallback = resolve(tmpdir(), "codex-companion");
  if (resolve(stateRoot) === fallback) delete env.CLAUDE_PLUGIN_DATA;
  else env.CLAUDE_PLUGIN_DATA = dirname(stateRoot);
  return env;
}

function companionResult(info) {
  try {
    const args = ["result", info.job.id, "--cwd", info.job.workspaceRoot, "--json"];
    const run = runCompanion(args, { env: companionEnv(info.stateRoot) });
    if (run.status !== 0) return null;
    const stored = JSON.parse(run.stdout).storedJob;
    return stored?.result?.rawOutput || stored?.rendered || null;
  } catch {
    return null;
  }
}

function threadIdFor(job) {
  if (job.threadId) return job.threadId;
  if (!job.logFile || !existsSync(job.logFile)) return null;
  return readFileSync(job.logFile, "utf8").match(/Thread ready \(([^)]+)\)/u)?.[1] ?? null;
}

function receiptsDirectory() {
  return resolve(
    process.env.CODEX_DISPATCH_RECEIPTS_DIR
      ?? join(homedir(), ".codex", "engineering-loop", "receipts"),
  );
}

function receiptPath(jobId) {
  return join(receiptsDirectory(), `${jobId}.json`);
}

function validateReceipt(value, jobId) {
  if (
    value?.schemaVersion !== 1
    || value.jobId !== jobId
    || !ROLLOUT_ID.test(value.threadId ?? "")
    || !ROLLOUT_ID.test(value.turnId ?? "")
    || typeof value.workspace !== "string"
    || value.workspace.length === 0
    || !Number.isFinite(Date.parse(value.timestamp ?? ""))
  ) {
    throw new Error("Receipt is missing a valid job, thread, turn, workspace, or timestamp.");
  }
  return value;
}

function readReceipt(jobId) {
  if (!SAFE_JOB_ID.test(jobId)) return { status: "missing", receipt: null };
  const file = receiptPath(jobId);
  if (!existsSync(file)) return { status: "missing", receipt: null };
  try {
    return { status: "valid", receipt: validateReceipt(JSON.parse(readFileSync(file, "utf8")), jobId) };
  } catch (error) {
    return {
      status: "invalid",
      receipt: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function sameReceipt(existing, next) {
  return existing.jobId === next.jobId
    && existing.threadId === next.threadId
    && existing.turnId === next.turnId
    && resolve(existing.workspace) === resolve(next.workspace);
}

function syncDirectory(directory) {
  let descriptor;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch {
    // The receipt file itself has already been synced; some platforms reject directory fsync.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeReceipt(receipt) {
  validateReceipt(receipt, receipt.jobId);
  const directory = receiptsDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const existing = readReceipt(receipt.jobId);
  if (existing.status === "invalid") {
    throw new Error(`Refusing to replace invalid receipt for job ${receipt.jobId}.`);
  }
  if (existing.status === "valid") {
    if (!sameReceipt(existing.receipt, receipt)) {
      throw new Error(`Refusing to replace conflicting receipt for job ${receipt.jobId}.`);
    }
    return receiptPath(receipt.jobId);
  }

  const destination = receiptPath(receipt.jobId);
  const temporary = join(directory, `.${receipt.jobId}.${process.pid}.${Date.now()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, destination);
    syncDirectory(directory);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return destination;
}

function sessionsDirectory() {
  return resolve(process.env.CODEX_DISPATCH_SESSIONS_DIR ?? join(homedir(), ".codex", "sessions"));
}

function rolloutFiles(directory, threadId, found = []) {
  if (!existsSync(directory)) return found;
  const suffix = `-${threadId}.jsonl`.toLowerCase();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) rolloutFiles(target, threadId, found);
    else if (entry.name.toLowerCase().endsWith(suffix)) found.push(target);
  }
  return found;
}

function readRollout(file) {
  let session = null;
  const completions = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/u)) {
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "session_meta") {
        session = {
          threadId: event.payload?.id ?? event.payload?.session_id ?? null,
          timestamp: event.payload?.timestamp ?? event.timestamp ?? null,
          workspace: event.payload?.cwd ?? null,
        };
      }
      if (event.payload?.type === "task_complete") {
        completions.push({
          turnId: event.payload.turn_id ?? null,
          report: typeof event.payload.last_agent_message === "string"
            ? event.payload.last_agent_message
            : null,
        });
      }
    } catch {
      // Rollouts may contain a partial final line while Codex is still writing.
    }
  }
  return { file, session, completions };
}

function availableTurnIds(rollout) {
  return [...new Set(rollout.completions.map(({ turnId }) => turnId).filter(Boolean))];
}

function recoverRollout(threadId, turnId = null) {
  if (!ROLLOUT_ID.test(threadId ?? "")) return { ok: false, reason: "invalid-thread-id" };
  if (turnId !== null && !ROLLOUT_ID.test(turnId)) return { ok: false, reason: "invalid-turn-id" };

  const rollouts = rolloutFiles(sessionsDirectory(), threadId)
    .map((file) => readRollout(file))
    .filter(({ session }) => session?.threadId === threadId);
  if (rollouts.length === 0) return { ok: false, reason: "rollout-not-found" };
  if (rollouts.length > 1) {
    return { ok: false, reason: "ambiguous-rollout", rolloutCount: rollouts.length };
  }

  const [rollout] = rollouts;
  if (turnId === null && rollout.completions.length > 1) {
    return {
      ok: false,
      reason: "turn-required",
      availableTurnIds: availableTurnIds(rollout),
    };
  }
  const matching = turnId === null
    ? rollout.completions
    : rollout.completions.filter((completion) => completion.turnId === turnId);
  if (matching.length === 0) {
    return {
      ok: false,
      reason: turnId === null ? "task-not-complete" : "turn-not-complete",
      availableTurnIds: availableTurnIds(rollout),
    };
  }
  if (matching.length > 1) {
    return { ok: false, reason: "ambiguous-turn", availableTurnIds: availableTurnIds(rollout) };
  }
  if (!matching[0].report) {
    return { ok: false, reason: "terminal-without-report", availableTurnIds: availableTurnIds(rollout) };
  }
  return {
    ok: true,
    threadId,
    turnId: matching[0].turnId,
    workspace: rollout.session.workspace,
    report: matching[0].report,
  };
}

function jobTimestamp(jobId) {
  const encoded = jobId.match(TIMESTAMPED_JOB_ID)?.[1];
  if (!encoded) return null;
  const timestamp = Number.parseInt(encoded, 36);
  const earliest = Date.parse("2020-01-01T00:00:00.000Z");
  if (!Number.isSafeInteger(timestamp) || timestamp < earliest || timestamp > Date.now() + 86400000) {
    return null;
  }
  return timestamp;
}

function sessionDateDirectories(timestamp) {
  const directories = [];
  for (const offset of [-86400000, 0, 86400000]) {
    const date = new Date(timestamp + offset);
    directories.push(join(
      sessionsDirectory(),
      String(date.getUTCFullYear()),
      String(date.getUTCMonth() + 1).padStart(2, "0"),
      String(date.getUTCDate()).padStart(2, "0"),
    ));
  }
  return [...new Set(directories)];
}

function discoveryHints(jobId) {
  const timestamp = jobTimestamp(jobId);
  if (timestamp === null) return [];
  const files = [];
  for (const directory of sessionDateDirectories(timestamp)) {
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        files.push(join(directory, entry.name));
      }
    }
  }
  return files
    .map((file) => readRollout(file))
    .map((rollout) => ({
      rollout,
      sessionTime: Date.parse(rollout.session?.timestamp ?? ""),
    }))
    .filter(({ rollout, sessionTime }) => (
      ROLLOUT_ID.test(rollout.session?.threadId ?? "")
      && Number.isFinite(sessionTime)
      && Math.abs(sessionTime - timestamp) <= DISCOVERY_WINDOW_MS
    ))
    .sort((a, b) => Math.abs(a.sessionTime - timestamp) - Math.abs(b.sessionTime - timestamp))
    .slice(0, 10)
    .map(({ rollout, sessionTime }) => ({
      threadId: rollout.session.threadId,
      turnIds: availableTurnIds(rollout),
      workspace: rollout.session.workspace,
      sessionTimestamp: new Date(sessionTime).toISOString(),
      deltaMs: sessionTime - timestamp,
    }));
}

function stateMapping(info) {
  if (!info) return null;
  return {
    jobId: info.job.id,
    threadId: threadIdFor(info.job),
    turnId: info.job.turnId ?? null,
    workspace: info.job.workspaceRoot ?? null,
  };
}

function mappingsConflict(state, receipt) {
  if (!state || !receipt) return false;
  return (state.threadId && state.threadId !== receipt.threadId)
    || (state.turnId && state.turnId !== receipt.turnId)
    || (state.workspace && resolve(state.workspace) !== resolve(receipt.workspace));
}

async function dispatch(options) {
  allowOnly(options, new Set(["cwd", "mode", "prompt-file"]));
  const cwd = resolve(required(options, "cwd"));
  const promptFile = resolve(required(options, "prompt-file"));
  if (required(options, "mode") !== "fresh") throw new UsageError("--mode must be fresh.");
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`Not a directory: ${cwd}`);
  if (!existsSync(promptFile)) throw new Error(`Prompt file does not exist: ${promptFile}`);
  const args = ["task", "--background", "--write", "--fresh", "--cwd", cwd,
    "--prompt-file", promptFile, "--json"];
  const run = runCompanion(args);
  if (run.status !== 0) throw new Error(run.stderr.trim() || "Companion dispatch failed.");
  const launched = JSON.parse(run.stdout);
  const deadline = Date.now() + 10000;
  let info;
  do {
    const found = locateJobs(launched.jobId);
    if (found.length > 1) throw new Error(`Ambiguous companion state found for job ${launched.jobId}.`);
    [info] = found;
    if ((info?.job.threadId && info?.job.turnId) || Date.now() >= deadline) break;
    await new Promise((done) => setTimeout(done, 100));
  } while (true);
  if (!info?.job.threadId || !info?.job.turnId) {
    throw new Error(
      `Dispatched job ${launched.jobId}, but exact thread and turn identifiers were unavailable; no receipt was written.`,
    );
  }
  const receipt = {
    schemaVersion: 1,
    jobId: launched.jobId,
    threadId: info.job.threadId,
    turnId: info.job.turnId,
    workspace: info.job.workspaceRoot ?? cwd,
    timestamp: info.job.createdAt ?? new Date().toISOString(),
  };
  const storedAt = writeReceipt(receipt);
  print({ jobId: receipt.jobId, threadId: receipt.threadId, turnId: receipt.turnId, receipt: storedAt });
}

function poll(options) {
  allowOnly(options, new Set(["job"]));
  const { job } = findJob(required(options, "job"));
  const last = lastLogEvent(job.logFile);
  const phase = job.phase ?? job.status ?? "unknown";
  const likelyDetached = phase === "running" && last.seconds !== null && last.seconds > 120;
  print({ phase, lastEventAt: last.at, secondsSinceLastEvent: last.seconds, likelyDetached });
  if (likelyDetached) process.exitCode = EXIT.DETACHED;
  else if (ACTIVE.has(job.status)) process.exitCode = EXIT.ACTIVE;
  else if (job.status !== "completed") process.exitCode = EXIT.NO_RESULT;
}

function resultForThread(threadId, turnId) {
  const recovered = recoverRollout(threadId, turnId);
  if (!recovered.ok) {
    return noResult({ jobId: null, threadId, turnId, ...recovered });
  }
  print({
    source: "rollout",
    mappingSource: "thread",
    jobId: null,
    threadId: recovered.threadId,
    turnId: recovered.turnId,
    workspace: recovered.workspace,
    report: recovered.report,
  });
}

function resultForJob(jobId, requestedTurnId) {
  if (!SAFE_JOB_ID.test(jobId)) {
    return noResult({ jobId, threadId: null, turnId: requestedTurnId, reason: "invalid-job-id" });
  }
  if (requestedTurnId !== null && !ROLLOUT_ID.test(requestedTurnId)) {
    return noResult({ jobId, threadId: null, turnId: requestedTurnId, reason: "invalid-turn-id" });
  }
  const found = locateJobs(jobId);
  if (found.length > 1) {
    return noResult({ jobId, threadId: null, turnId: requestedTurnId, reason: "ambiguous-companion-state" });
  }
  const [info] = found;
  const state = stateMapping(info);
  const stored = readReceipt(jobId);
  if (stored.status === "invalid") {
    return noResult({
      jobId,
      threadId: state?.threadId ?? null,
      turnId: requestedTurnId ?? state?.turnId ?? null,
      reason: "invalid-receipt",
      receiptError: stored.error,
    });
  }
  if (mappingsConflict(state, stored.receipt)) {
    return noResult({
      jobId,
      threadId: null,
      turnId: requestedTurnId,
      reason: "conflicting-state-and-receipt",
    });
  }
  const mapping = stored.receipt ?? state;
  if (requestedTurnId && mapping?.turnId && requestedTurnId !== mapping.turnId) {
    return noResult({
      jobId,
      threadId: mapping.threadId,
      turnId: requestedTurnId,
      reason: "turn-conflicts-with-job-mapping",
    });
  }

  const own = info && (!requestedTurnId || mapping?.turnId)
    ? companionResult(info)
    : null;
  if (own) {
    return print({
      source: "companion",
      mappingSource: "companion-state",
      jobId,
      threadId: mapping?.threadId ?? null,
      turnId: requestedTurnId ?? mapping?.turnId ?? null,
      workspace: mapping?.workspace ?? null,
      report: own,
    });
  }
  if (mapping?.threadId) {
    const turnId = requestedTurnId ?? mapping.turnId ?? null;
    const recovered = recoverRollout(mapping.threadId, turnId);
    if (recovered.ok) {
      return print({
        source: "rollout",
        mappingSource: stored.receipt ? "receipt" : "companion-state",
        jobId,
        threadId: recovered.threadId,
        turnId: recovered.turnId,
        workspace: recovered.workspace ?? mapping.workspace,
        report: recovered.report,
      });
    }
    return noResult({ jobId, threadId: mapping.threadId, turnId, ...recovered });
  }

  return noResult({
    jobId,
    threadId: null,
    turnId: requestedTurnId,
    reason: "unmapped-job",
    discoveryHints: discoveryHints(jobId),
  });
}

function result(options) {
  allowOnly(options, new Set(["job", "thread", "turn"]));
  const hasJob = Boolean(options.job);
  const hasThread = Boolean(options.thread);
  if (hasJob === hasThread) {
    throw new UsageError("Provide exactly one of --job or --thread.");
  }
  if (hasThread) return resultForThread(options.thread, options.turn ?? null);
  return resultForJob(options.job, options.turn ?? null);
}

async function main() {
  if (process.argv.includes("--help") || process.argv.length < 3) return usage();
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "dispatch") return dispatch(options);
  if (command === "poll") return poll(options);
  if (command === "result") return result(options);
  throw new UsageError(`Unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof UsageError ? EXIT.USAGE : EXIT.ERROR;
});
