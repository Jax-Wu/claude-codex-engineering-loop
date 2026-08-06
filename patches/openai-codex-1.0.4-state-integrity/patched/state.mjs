import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;

// --- integrity additions ------------------------------------------------
// See patches/openai-codex-1.0.4-state-integrity/README.md. Three defects that
// compound: a plain writeFileSync could leave a torn state.json, a torn
// state.json was silently read back as "no jobs have ever run", and the next
// write then persisted that emptiness over everything else. On top of that,
// read-modify-write was unlocked, so two processes lost each other's updates.
const LOCK_DIR_NAME = ".state.lock";
// Well above any real read-modify-write, which is a few file operations. Only a
// crashed holder stays longer, and that is exactly what this reclaims.
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_POLL_MS = 25;
// Reentrancy: updateState takes the lock and then calls saveState, which takes
// it again. Counting depth per path keeps that from self-deadlocking.
const heldLocks = new Map();

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockPath(cwd) {
  return path.join(resolveStateDir(cwd), LOCK_DIR_NAME);
}

// mkdir is the primitive: it either creates the directory or fails with EEXIST,
// atomically, on every filesystem this runs on.
function acquireLock(cwd) {
  const dir = lockPath(cwd);
  const depth = heldLocks.get(dir) ?? 0;
  if (depth > 0) {
    heldLocks.set(dir, depth + 1);
    return dir;
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      fs.mkdirSync(dir);
      heldLocks.set(dir, 1);
      return dir;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      let ageMs = 0;
      try {
        ageMs = Date.now() - fs.statSync(dir).mtimeMs;
      } catch {
        continue;
      }
      if (ageMs > LOCK_STALE_MS) {
        try {
          fs.rmdirSync(dir);
        } catch {
          // Someone else reclaimed it first; the next mkdir attempt decides.
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for the Codex state lock at ${dir}. Another process is writing state. `
          + `If nothing is running, remove that directory.`
        );
      }
      sleepSync(LOCK_POLL_MS);
    }
  }
}

function releaseLock(dir) {
  const depth = heldLocks.get(dir) ?? 0;
  if (depth > 1) {
    heldLocks.set(dir, depth - 1);
    return;
  }
  heldLocks.delete(dir);
  try {
    fs.rmdirSync(dir);
  } catch {
    // Already reclaimed as stale by another process.
  }
}

function withStateLock(cwd, run) {
  const dir = acquireLock(cwd);
  try {
    return run();
  } finally {
    releaseLock(dir);
  }
}

// Write to a temporary file, flush it, then rename over the destination. Rename
// is atomic within a directory, so a reader sees either the whole previous file
// or the whole new one -- never the half-written bytes that used to be read back
// as empty state.
function writeFileAtomic(destination, contents) {
  const directory = path.dirname(destination);
  const unique = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const temporary = path.join(directory, `.${path.basename(destination)}.${unique}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, contents, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, destination);
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    if (fs.existsSync(temporary)) {
      fs.unlinkSync(temporary);
    }
  }
  return destination;
}

function quarantineCorruptState(stateFile, reason) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantine = `${stateFile}.corrupt-${stamp}`;
  try {
    fs.renameSync(stateFile, quarantine);
  } catch {
    // If it cannot be moved aside, the error below still stops the caller.
  }
  throw new Error(
    `Codex state at ${stateFile} is unreadable (${reason}) and has been moved to ${quarantine}. `
    + `It was NOT treated as empty state: doing that would rewrite the index and drop every other `
    + `job record. Rerun to start from empty state, and read the quarantined file if job history matters.`
  );
}
// --- end integrity additions --------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch (error) {
    return quarantineCorruptState(stateFile, error instanceof Error ? error.message : String(error));
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return quarantineCorruptState(stateFile, "top-level value is not an object");
  }

  return {
    ...defaultState(),
    ...parsed,
    config: {
      ...defaultState().config,
      ...(parsed.config ?? {})
    },
    jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
  };
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function saveState(cwd, state) {
  return withStateLock(cwd, () => {
    const previousJobs = loadState(cwd).jobs;
    ensureStateDir(cwd);
    const nextJobs = pruneJobs(state.jobs ?? []);
    const nextState = {
      version: STATE_VERSION,
      config: {
        ...defaultState().config,
        ...(state.config ?? {})
      },
      jobs: nextJobs
    };

    const retainedIds = new Set(nextJobs.map((job) => job.id));
    for (const job of previousJobs) {
      if (retainedIds.has(job.id)) {
        continue;
      }
      removeJobFile(resolveJobFile(cwd, job.id));
      removeFileIfExists(job.logFile);
    }

    writeFileAtomic(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);
    return nextState;
  });
}

// The lock spans read *and* write. Previously two processes could both read the
// same state, each add one job, and each write back a version missing the
// other's -- a lost update with no error anywhere.
export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    mutate(state);
    return saveState(cwd, state);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

// No lock: each job file has a single writer and is not read-modify-write. It
// still needs the atomic replace, because a torn job file is what produced the
// 08-03 record that said "failed" while the state index said "cancelled".
export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  writeFileAtomic(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
