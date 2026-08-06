import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The 2026-08-03 incident: a rescue agent's first `task` call timed out in the
// foreground, so it made a second fresh call. Both jobs were write-capable
// against the same worktree. Nothing in the code stopped that -- the "exactly
// one invocation" rule lived only in prose. These tests pin the two mechanisms
// that replace the prose: repeating the same attempt returns the job that
// already exists, and starting a different attempt while one is still live is
// refused rather than silently allowed.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dispatcher = join(root, "scripts", "codex-dispatch.mjs");
const THREAD = "11111111-1111-7111-8111-111111111111";
const TURN = "22222222-2222-7222-8222-222222222222";
const EXIT_USAGE = 2;
const EXIT_CONFLICT = 6;

function makeFixture() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "codex-lease-test-"));
  const fixture = {
    root: fixtureRoot,
    workspace: join(fixtureRoot, "repo"),
    sessions: join(fixtureRoot, "sessions"),
    receipts: join(fixtureRoot, "receipts"),
    leases: join(fixtureRoot, "leases"),
    pluginData: join(fixtureRoot, "plugin-data"),
    companion: join(fixtureRoot, "fake-companion.mjs"),
    calls: join(fixtureRoot, "companion-calls.log"),
    prompt: join(fixtureRoot, "prompt.md"),
  };
  mkdirSync(fixture.workspace, { recursive: true });
  writeFileSync(fixture.prompt, "Implement the fixture.\n", "utf8");
  return fixture;
}

// Each call writes a distinct job whose status is read from a file the test
// controls, so a test can retire a job without racing a real companion.
function installCompanion(fixture, { status = "running" } = {}) {
  writeFileSync(join(fixture.root, "job-status"), status, "utf8");
  writeFileSync(fixture.companion, `
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const cwd = process.argv[process.argv.indexOf("--cwd") + 1];
appendFileSync(${JSON.stringify(fixture.calls)}, "call\\n");
const n = readFileSync(${JSON.stringify(fixture.calls)}, "utf8").trim().split("\\n").length;
const jobId = "task-fixture-" + n;
const jobs = join(process.env.CLAUDE_PLUGIN_DATA, "state", "fixture", "jobs");
mkdirSync(jobs, { recursive: true });
const status = readFileSync(join(${JSON.stringify(fixture.root)}, "job-status"), "utf8").trim();
writeFileSync(join(jobs, jobId + ".json"), JSON.stringify({
  id: jobId,
  threadId: "${THREAD}",
  turnId: "${TURN}",
  workspaceRoot: cwd,
  createdAt: "2026-08-03T09:00:00.000Z",
  status,
  phase: status
}));
process.stdout.write(JSON.stringify({ jobId }));
`, "utf8");
}

function setJobStatus(fixture, status) {
  writeFileSync(join(fixture.root, "job-status"), status, "utf8");
  const jobs = join(fixture.pluginData, "state", "fixture", "jobs");
  for (const file of [...Array(9).keys()].map((n) => join(jobs, `task-fixture-${n + 1}.json`))) {
    if (!existsSync(file)) continue;
    const job = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...job, status, phase: status }), "utf8");
  }
}

function run(fixture, args) {
  return spawnSync(process.execPath, [dispatcher, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_DISPATCH_SESSIONS_DIR: fixture.sessions,
      CODEX_DISPATCH_RECEIPTS_DIR: fixture.receipts,
      CODEX_DISPATCH_LEASES_DIR: fixture.leases,
      CLAUDE_PLUGIN_DATA: fixture.pluginData,
      CODEX_COMPANION_PATH: fixture.companion,
    },
  });
}

function dispatch(fixture, attempt) {
  return run(fixture, [
    "dispatch", "--cwd", fixture.workspace, "--mode", "fresh",
    "--prompt-file", fixture.prompt, "--attempt", attempt,
  ]);
}

function companionCalls(fixture) {
  return existsSync(fixture.calls)
    ? readFileSync(fixture.calls, "utf8").trim().split("\n").filter(Boolean).length
    : 0;
}

test("dispatch requires an attempt id", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  installCompanion(fixture);

  const result = run(fixture, [
    "dispatch", "--cwd", fixture.workspace, "--mode", "fresh", "--prompt-file", fixture.prompt,
  ]);
  assert.equal(result.status, EXIT_USAGE);
  assert.match(result.stderr, /--attempt/u);
  assert.equal(companionCalls(fixture), 0, "nothing may be launched without an attempt id");
});

test("repeating the same attempt returns the existing job instead of launching again", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  installCompanion(fixture);

  const first = dispatch(fixture, "run-1:round-0:execute");
  assert.equal(first.status, 0, first.stderr);
  const firstOut = JSON.parse(first.stdout);
  assert.equal(firstOut.reused, false);

  const second = dispatch(fixture, "run-1:round-0:execute");
  assert.equal(second.status, 0, second.stderr);
  const secondOut = JSON.parse(second.stdout);
  assert.equal(secondOut.reused, true);
  assert.equal(secondOut.jobId, firstOut.jobId);
  assert.equal(secondOut.threadId, firstOut.threadId);
  assert.equal(companionCalls(fixture), 1, "the second dispatch must not start a second job");
});

test("a different attempt is refused while the held job is still active", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  installCompanion(fixture);

  const held = JSON.parse(dispatch(fixture, "run-1:round-0:execute").stdout);
  const second = dispatch(fixture, "run-1:round-0:execute-retry");

  assert.equal(second.status, EXIT_CONFLICT);
  const out = JSON.parse(second.stdout);
  assert.equal(out.reason, "workspace-lease-held");
  assert.equal(out.heldBy.attempt, "run-1:round-0:execute");
  assert.equal(out.heldBy.jobId, held.jobId);
  assert.equal(companionCalls(fixture), 1, "a second write-capable job must not start");
});

test("a different attempt proceeds once the held job is terminal", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  installCompanion(fixture);

  dispatch(fixture, "run-1:round-0:execute");
  setJobStatus(fixture, "completed");

  const second = dispatch(fixture, "run-1:round-1:fix");
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).reused, false);
  assert.equal(companionCalls(fixture), 2);
});

test("release abandons a lease so a new attempt can proceed", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  installCompanion(fixture);

  const held = JSON.parse(dispatch(fixture, "run-1:round-0:execute").stdout);

  const released = run(fixture, ["release", "--cwd", fixture.workspace]);
  assert.equal(released.status, 0, released.stderr);
  assert.equal(JSON.parse(released.stdout).released.jobId, held.jobId);

  const second = dispatch(fixture, "run-1:round-0:execute-retry");
  assert.equal(second.status, 0, second.stderr);
  assert.equal(companionCalls(fixture), 2);
});

test("release refuses when the named attempt is not the holder", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  installCompanion(fixture);
  dispatch(fixture, "run-1:round-0:execute");

  const wrong = run(fixture, ["release", "--cwd", fixture.workspace, "--attempt", "some-other"]);
  assert.equal(wrong.status, EXIT_CONFLICT);
  assert.equal(JSON.parse(wrong.stdout).reason, "attempt-mismatch");
});

test("lease reports the holder without changing it", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  installCompanion(fixture);
  const held = JSON.parse(dispatch(fixture, "run-1:round-0:execute").stdout);

  const first = run(fixture, ["lease", "--cwd", fixture.workspace]);
  assert.equal(first.status, 0, first.stderr);
  const out = JSON.parse(first.stdout);
  assert.equal(out.held, true);
  assert.equal(out.lease.jobId, held.jobId);
  assert.equal(out.jobStatus, "running");

  const second = run(fixture, ["lease", "--cwd", fixture.workspace]);
  assert.deepEqual(JSON.parse(second.stdout), out, "inspection must not mutate the lease");
});

test("an unverifiable lease is refused rather than assumed dead", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  installCompanion(fixture);
  dispatch(fixture, "run-1:round-0:execute");

  // Companion state pruned and no rollout exists: we cannot prove the job
  // finished. Guessing "probably dead" is exactly the 08-03 mistake.
  rmSync(join(fixture.pluginData, "state", "fixture", "jobs"), { recursive: true, force: true });

  const second = dispatch(fixture, "run-1:round-0:execute-retry");
  assert.equal(second.status, EXIT_CONFLICT);
  assert.equal(JSON.parse(second.stdout).reason, "workspace-lease-unverifiable");
  assert.equal(companionCalls(fixture), 1);
});

test("leases are per workspace", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  installCompanion(fixture);
  const other = join(fixture.root, "other-repo");
  mkdirSync(other, { recursive: true });

  dispatch(fixture, "run-1:round-0:execute");
  const elsewhere = run(fixture, [
    "dispatch", "--cwd", other, "--mode", "fresh",
    "--prompt-file", fixture.prompt, "--attempt", "run-2:round-0:execute",
  ]);
  assert.equal(elsewhere.status, 0, elsewhere.stderr);
  assert.equal(companionCalls(fixture), 2);
});
