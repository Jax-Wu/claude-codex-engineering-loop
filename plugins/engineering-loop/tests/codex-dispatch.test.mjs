import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dispatcher = join(root, "scripts", "codex-dispatch.mjs");
const THREAD_ONE = "11111111-1111-7111-8111-111111111111";
const TURN_ONE = "22222222-2222-7222-8222-222222222222";
const THREAD_MANY = "33333333-3333-7333-8333-333333333333";
const TURN_FIRST = "44444444-4444-7444-8444-444444444444";
const TURN_SECOND = "55555555-5555-7555-8555-555555555555";

function runDispatcher(args, fixture, extraEnv = {}) {
  return spawnSync(process.execPath, [dispatcher, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_DISPATCH_SESSIONS_DIR: fixture.sessions,
      CODEX_DISPATCH_RECEIPTS_DIR: fixture.receipts,
      CODEX_DISPATCH_LEASES_DIR: fixture.leases,
      ...extraEnv,
    },
  });
}

function writeRollout(fixture, threadId, timestamp, completions) {
  const date = new Date(timestamp);
  const directory = join(
    fixture.sessions,
    String(date.getUTCFullYear()),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  );
  mkdirSync(directory, { recursive: true });
  const events = [
    {
      timestamp,
      type: "session_meta",
      payload: { session_id: threadId, timestamp, cwd: fixture.root },
    },
    ...completions.map(({ turnId, report }) => ({
      timestamp,
      type: "event_msg",
      payload: { type: "task_complete", turn_id: turnId, last_agent_message: report },
    })),
  ];
  writeFileSync(
    join(directory, `rollout-${timestamp.replaceAll(":", "-")}-${threadId}.jsonl`),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
}

function makeFixture() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "codex-dispatch-test-"));
  const fixture = {
    root: fixtureRoot,
    sessions: join(fixtureRoot, "sessions"),
    receipts: join(fixtureRoot, "receipts"),
    leases: join(fixtureRoot, "leases"),
  };
  writeRollout(fixture, THREAD_ONE, "2026-08-03T07:27:21.990Z", [
    { turnId: TURN_ONE, report: "single exact report" },
  ]);
  writeRollout(fixture, THREAD_MANY, "2026-08-03T08:00:00.000Z", [
    { turnId: TURN_FIRST, report: "first report" },
    { turnId: TURN_SECOND, report: "second report" },
  ]);
  return fixture;
}

test("recovers a single completed turn directly from an exact thread id", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  const result = runDispatcher(["result", "--thread", THREAD_ONE], fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    source: "rollout",
    mappingSource: "thread",
    jobId: null,
    threadId: THREAD_ONE,
    turnId: TURN_ONE,
    workspace: fixture.root,
    report: "single exact report",
  });
});

test("uses a durable receipt after companion state is absent", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const jobId = "task-receiptfixture-abc123";
  mkdirSync(fixture.receipts, { recursive: true });
  writeFileSync(join(fixture.receipts, `${jobId}.json`), `${JSON.stringify({
    schemaVersion: 1,
    jobId,
    threadId: THREAD_ONE,
    turnId: TURN_ONE,
    workspace: fixture.root,
    timestamp: "2026-08-03T07:27:21.569Z",
  })}\n`, "utf8");

  const result = runDispatcher(["result", "--job", jobId], fixture);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.mappingSource, "receipt");
  assert.equal(output.report, "single exact report");
});

test("refuses ambiguous, wrong, and missing result selectors", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  const ambiguous = runDispatcher(["result", "--thread", THREAD_MANY], fixture);
  assert.equal(ambiguous.status, 5);
  assert.equal(JSON.parse(ambiguous.stdout).reason, "turn-required");
  assert.equal(JSON.parse(ambiguous.stdout).report, null);

  const exact = runDispatcher(
    ["result", "--thread", THREAD_MANY, "--turn", TURN_SECOND],
    fixture,
  );
  assert.equal(exact.status, 0, exact.stderr);
  assert.equal(JSON.parse(exact.stdout).report, "second report");

  const wrong = runDispatcher(
    ["result", "--thread", "99999999-9999-7999-8999-999999999999"],
    fixture,
  );
  assert.equal(wrong.status, 5);
  assert.equal(JSON.parse(wrong.stdout).report, null);

  const missing = runDispatcher(["result"], fixture);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /exactly one of --job or --thread/u);
});

test("keeps timestamp discovery as a non-result hint", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const timestamp = Date.parse("2026-08-03T07:27:21.569Z");
  const jobId = `task-${timestamp.toString(36)}-legacy`;

  const result = runDispatcher(["result", "--job", jobId], fixture);
  assert.equal(result.status, 5);
  const output = JSON.parse(result.stdout);
  assert.equal(output.report, null);
  assert.equal(output.reason, "unmapped-job");
  assert.equal(output.discoveryHints[0].threadId, THREAD_ONE);
});

test("dispatch atomically persists job, thread, turn, workspace, and timestamp", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const companion = join(fixture.root, "fake-companion.mjs");
  const prompt = join(fixture.root, "prompt.md");
  const pluginData = join(fixture.root, "plugin-data");
  const jobId = "task-dispatchfixture-abc123";
  writeFileSync(prompt, "Implement the fixture.\n", "utf8");
  writeFileSync(companion, `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const cwd = process.argv[process.argv.indexOf("--cwd") + 1];
const jobs = join(process.env.CLAUDE_PLUGIN_DATA, "state", "fixture", "jobs");
mkdirSync(jobs, { recursive: true });
writeFileSync(join(jobs, "${jobId}.json"), JSON.stringify({
  id: "${jobId}",
  threadId: "${THREAD_ONE}",
  turnId: "${TURN_ONE}",
  workspaceRoot: cwd,
  createdAt: "2026-08-03T09:00:00.000Z",
  status: "running",
  phase: "running"
}));
process.stdout.write(JSON.stringify({ jobId: "${jobId}" }));
`, "utf8");

  const result = runDispatcher(
    ["dispatch", "--cwd", fixture.root, "--mode", "fresh", "--prompt-file", prompt,
      "--attempt", "run-fixture:round-0:execute"],
    fixture,
    { CLAUDE_PLUGIN_DATA: pluginData, CODEX_COMPANION_PATH: companion },
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.reused, false);
  const receipt = JSON.parse(readFileSync(output.receipt, "utf8"));
  assert.deepEqual(receipt, {
    schemaVersion: 1,
    jobId,
    threadId: THREAD_ONE,
    turnId: TURN_ONE,
    workspace: fixture.root,
    timestamp: "2026-08-03T09:00:00.000Z",
  });
});

// ── poll liveness ────────────────────────────────────────────────────────────
// The 2026-08-11 incident: a rescue job died between "thread ready" and any
// agent output. Companion state kept `status: running, phase: starting` with a
// pid that no longer existed, and poll answered "still active" forever, so the
// reader waited on a corpse. Silence is the failure mode these cover.

function writeJob(fixture, job) {
  const stateRoot = join(fixture.root, "plugin-data", "state", "workspace", "jobs");
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(join(stateRoot, `${job.id}.json`), JSON.stringify(job), "utf8");
  return { CLAUDE_PLUGIN_DATA: join(fixture.root, "plugin-data") };
}

function writeLog(fixture, name, secondsAgo) {
  const file = join(fixture.root, `${name}.log`);
  const at = new Date(Date.now() - secondsAgo * 1000).toISOString();
  writeFileSync(file, `[${at}] Turn started (t).\n`, "utf8");
  return file;
}

function deadPid() {
  // A pid that is real enough to look plausible but is certainly gone: spawn a
  // trivial child, wait for it, then reuse its number.
  const done = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  return done.pid;
}

test("poll flags a dead reader even when the phase never reached running", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const env = writeJob(fixture, {
    id: "task-dead-starting",
    status: "running",
    phase: "starting",
    pid: deadPid(),
    logFile: writeLog(fixture, "dead-starting", 900),
  });
  const result = runDispatcher(["poll", "--job", "task-dead-starting"], fixture, env);
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).likelyDetached, true);
});

test("poll flags a stalled job whose phase is still starting", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const env = writeJob(fixture, {
    id: "task-stalled-starting",
    status: "running",
    phase: "starting",
    logFile: writeLog(fixture, "stalled-starting", 900),
  });
  const result = runDispatcher(["poll", "--job", "task-stalled-starting"], fixture, env);
  assert.equal(result.status, 4, result.stdout + result.stderr);
});

test("poll leaves a live, recently-chatty job alone", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const env = writeJob(fixture, {
    id: "task-healthy",
    status: "running",
    phase: "running",
    pid: process.pid,
    logFile: writeLog(fixture, "healthy", 5),
  });
  const result = runDispatcher(["poll", "--job", "task-healthy"], fixture, env);
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).likelyDetached, false);
});

test("a live pid keeps a quiet job active, so long thinking is not killed", (t) => {
  // The false positive that would matter most: Codex reasoning for minutes with
  // nothing to log. Liveness must beat the log-silence heuristic here.
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const env = writeJob(fixture, {
    id: "task-quiet-alive",
    status: "running",
    phase: "running",
    pid: process.pid,
    logFile: writeLog(fixture, "quiet-alive", 900),
  });
  const result = runDispatcher(["poll", "--job", "task-quiet-alive"], fixture, env);
  assert.equal(result.status, 3, result.stdout + result.stderr);
});

test("a terminal job is never reported as detached", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const env = writeJob(fixture, {
    id: "task-done",
    status: "completed",
    phase: "running",
    pid: deadPid(),
    logFile: writeLog(fixture, "done", 900),
  });
  const result = runDispatcher(["poll", "--job", "task-done"], fixture, env);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
