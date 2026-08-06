import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Root cause #5 from LOOP-DIAGNOSIS. The companion's state layer had three
// defects that compound into silent data loss:
//
//   loadState swallowed a JSON parse error and returned empty state, so a
//   truncated file looked like "no jobs have ever run";
//   saveState wrote state.json with a plain writeFileSync, so a crash mid-write
//   produced exactly that truncated file;
//   updateState was an unlocked read-modify-write, so two processes could
//   interleave and one update just vanished.
//
// Together: a torn write becomes empty state becomes a rewritten index with
// every other job's record dropped. An observed torn result from 08-03 had one
// store saying "failed" while the other said "cancelled".
//
// These tests run against the patched copy in patches/, not the installed
// plugin cache -- the cache is disposable and may not have the patch at all.

const here = dirname(fileURLToPath(import.meta.url));
const patched = resolve(here, "..", "patches", "openai-codex-1.0.4-state-integrity", "patched", "state.mjs");

// state.mjs imports ./workspace.mjs, which the patch does not touch. Give it a
// stub that resolves to cwd so the tests need no git repository.
function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), "codex-state-test-"));
  const lib = join(root, "lib");
  mkdirSync(lib, { recursive: true });
  copyFileSync(patched, join(lib, "state.mjs"));
  writeFileSync(join(lib, "workspace.mjs"), "export function resolveWorkspaceRoot(cwd) { return cwd; }\n", "utf8");
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  return { root, lib, workspace, module: join(lib, "state.mjs") };
}

function runScript(sandbox, source) {
  const file = join(sandbox.root, `script-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, source, "utf8");
  return spawnSync(process.execPath, [file], { encoding: "utf8" });
}

function stateDirOf(sandbox) {
  const stateRoot = join(sandbox.root, "plugin-data", "state");
  const [entry] = readdirSync(stateRoot);
  return join(stateRoot, entry);
}

const preamble = (sandbox) => `
process.env.CLAUDE_PLUGIN_DATA = ${JSON.stringify(join(sandbox.root, "plugin-data"))};
const state = await import(${JSON.stringify(sandbox.module)});
const cwd = ${JSON.stringify(sandbox.workspace)};
`;

test("state is replaced by rename, not edited in place", (t) => {
  const sandbox = makeSandbox();
  t.after(() => rmSync(sandbox.root, { recursive: true, force: true }));

  const run = runScript(sandbox, `${preamble(sandbox)}
state.upsertJob(cwd, { id: "job-a", status: "running" });
`);
  assert.equal(run.status, 0, run.stderr);
  const dir = stateDirOf(sandbox);

  // A read-only destination inside a writable directory separates the two
  // mechanisms: an in-place writeFileSync fails with EACCES, while a rename over
  // the same path succeeds because rename needs directory permission, not file
  // permission. That is the property that makes a torn state file impossible --
  // readers either see the whole old file or the whole new one.
  chmodSync(join(dir, "state.json"), 0o444);
  const second = runScript(sandbox, `${preamble(sandbox)}
state.upsertJob(cwd, { id: "job-b", status: "running" });
`);
  chmodSync(join(dir, "state.json"), 0o644);
  assert.equal(second.status, 0, second.stderr);

  const stray = readdirSync(dir).filter((name) => name.includes(".tmp"));
  assert.deepEqual(stray, [], "an atomic write must not leave its temporary file behind");
  const parsed = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  assert.deepEqual(parsed.jobs.map((job) => job.id).sort(), ["job-a", "job-b"]);
});

test("job files are replaced by rename too", (t) => {
  const sandbox = makeSandbox();
  t.after(() => rmSync(sandbox.root, { recursive: true, force: true }));

  const run = runScript(sandbox, `${preamble(sandbox)}
state.writeJobFile(cwd, "job-a", { id: "job-a", status: "running" });
`);
  assert.equal(run.status, 0, run.stderr);
  const jobFile = join(stateDirOf(sandbox), "jobs", "job-a.json");
  chmodSync(jobFile, 0o444);

  const second = runScript(sandbox, `${preamble(sandbox)}
state.writeJobFile(cwd, "job-a", { id: "job-a", status: "completed" });
`);
  chmodSync(jobFile, 0o644);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(readFileSync(jobFile, "utf8")).status, "completed");
});

test("a corrupt state file is quarantined and reported, never read as empty", (t) => {
  const sandbox = makeSandbox();
  t.after(() => rmSync(sandbox.root, { recursive: true, force: true }));

  runScript(sandbox, `${preamble(sandbox)}
state.upsertJob(cwd, { id: "job-a", status: "running" });
`);
  const dir = stateDirOf(sandbox);
  writeFileSync(join(dir, "state.json"), '{"version":1,"jobs":[{"id":"job-a"', "utf8");

  const loud = runScript(sandbox, `${preamble(sandbox)}
state.loadState(cwd);
`);
  assert.notEqual(loud.status, 0, "a corrupt state file must not be swallowed");
  assert.match(loud.stderr, /state\.json/u);

  const quarantined = readdirSync(dir).filter((name) => name.startsWith("state.json.corrupt-"));
  assert.equal(quarantined.length, 1, "the unreadable bytes must be kept for diagnosis");
  assert.match(readFileSync(join(dir, quarantined[0]), "utf8"), /job-a/u);

  // Quarantining lets the next call start clean rather than wedging forever.
  const after = runScript(sandbox, `${preamble(sandbox)}
process.stdout.write(JSON.stringify(state.loadState(cwd).jobs));
`);
  assert.equal(after.status, 0, after.stderr);
  assert.deepEqual(JSON.parse(after.stdout), []);
});

test("a corrupt state file does not let a write silently drop every other job", (t) => {
  const sandbox = makeSandbox();
  t.after(() => rmSync(sandbox.root, { recursive: true, force: true }));

  runScript(sandbox, `${preamble(sandbox)}
state.upsertJob(cwd, { id: "job-a", status: "running" });
state.upsertJob(cwd, { id: "job-b", status: "running" });
`);
  const dir = stateDirOf(sandbox);
  const before = readFileSync(join(dir, "state.json"), "utf8");
  writeFileSync(join(dir, "state.json"), `${before.slice(0, 40)}`, "utf8");

  const write = runScript(sandbox, `${preamble(sandbox)}
state.upsertJob(cwd, { id: "job-c", status: "running" });
`);
  assert.notEqual(write.status, 0, "the write must fail loudly instead of rebuilding state from nothing");
});

test("concurrent updates from separate processes do not lose each other", async (t) => {
  const sandbox = makeSandbox();
  t.after(() => rmSync(sandbox.root, { recursive: true, force: true }));

  // Genuinely concurrent (spawn, not spawnSync) with a widened read-modify-write
  // window, so an unlocked implementation loses updates every run rather than
  // occasionally.
  const child = join(sandbox.root, "child.mjs");
  writeFileSync(child, `${preamble(sandbox)}
const id = process.argv[2];
state.updateState(cwd, (current) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  current.jobs.unshift({ id, status: "running", createdAt: new Date().toISOString() });
});
`, "utf8");

  const ids = ["job-1", "job-2", "job-3", "job-4", "job-5"];
  const codes = await Promise.all(ids.map((id) => new Promise((done, fail) => {
    const proc = spawn(process.execPath, [child, id], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => { stderr += chunk; });
    proc.on("error", fail);
    proc.on("exit", (code) => done({ id, code, stderr }));
  })));
  for (const result of codes) {
    assert.equal(result.code, 0, `${result.id}: ${result.stderr}`);
  }

  const parsed = JSON.parse(readFileSync(join(stateDirOf(sandbox), "state.json"), "utf8"));
  assert.deepEqual(parsed.jobs.map((job) => job.id).sort(), [...ids].sort());
});

test("an update holds a lock for the whole read-modify-write", (t) => {
  const sandbox = makeSandbox();
  t.after(() => rmSync(sandbox.root, { recursive: true, force: true }));

  runScript(sandbox, `${preamble(sandbox)}
state.upsertJob(cwd, { id: "job-a", status: "running" });
`);
  const lock = join(stateDirOf(sandbox), ".state.lock");

  const run = runScript(sandbox, `${preamble(sandbox)}
import { existsSync } from "node:fs";
let heldDuring = null;
state.updateState(cwd, (current) => {
  heldDuring = existsSync(${JSON.stringify(lock)});
  current.jobs.unshift({ id: "job-b", status: "running" });
});
process.stdout.write(JSON.stringify({ heldDuring, heldAfter: existsSync(${JSON.stringify(lock)}) }));
`);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { heldDuring: true, heldAfter: false });
});

test("the lock is released even when the mutation throws", (t) => {
  const sandbox = makeSandbox();
  t.after(() => rmSync(sandbox.root, { recursive: true, force: true }));

  runScript(sandbox, `${preamble(sandbox)}
state.upsertJob(cwd, { id: "job-a", status: "running" });
`);
  const lock = join(stateDirOf(sandbox), ".state.lock");

  const run = runScript(sandbox, `${preamble(sandbox)}
import { existsSync } from "node:fs";
try {
  state.updateState(cwd, () => { throw new Error("mutation failed"); });
} catch {}
process.stdout.write(JSON.stringify({ heldAfter: existsSync(${JSON.stringify(lock)}) }));
state.upsertJob(cwd, { id: "job-after", status: "running" });
`);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { heldAfter: false });
  const parsed = JSON.parse(readFileSync(join(stateDirOf(sandbox), "state.json"), "utf8"));
  assert.deepEqual(parsed.jobs.map((job) => job.id).sort(), ["job-a", "job-after"]);
});

test("a stale lock is broken instead of deadlocking", (t) => {
  const sandbox = makeSandbox();
  t.after(() => rmSync(sandbox.root, { recursive: true, force: true }));

  runScript(sandbox, `${preamble(sandbox)}
state.upsertJob(cwd, { id: "job-a", status: "running" });
`);
  const dir = stateDirOf(sandbox);
  const lock = join(dir, ".state.lock");
  mkdirSync(lock, { recursive: true });
  const longAgo = new Date(Date.now() - 60 * 60 * 1000);
  utimesSync(lock, longAgo, longAgo);

  const run = runScript(sandbox, `${preamble(sandbox)}
state.upsertJob(cwd, { id: "job-b", status: "running" });
`);
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  assert.deepEqual(parsed.jobs.map((job) => job.id).sort(), ["job-a", "job-b"]);
});
