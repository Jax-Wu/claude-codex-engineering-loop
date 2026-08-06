import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_STALE_AFTER_MS,
  assessJob,
  assessJobs,
  formatStaleWarning,
} from "../patches/openai-codex-1.0.4-stale-guard/patched/stale-jobs.mjs";

// Imports the repo copy, not the installed plugin cache: the cache is disposable
// and may be missing the guard entirely, and a test that silently stops covering
// anything is worse than no test.

const NOW = Date.parse("2026-08-06T12:00:00.000Z");
const ago = (minutes) => new Date(NOW - minutes * 60000).toISOString();
const at = (job) => assessJob(job, { now: NOW });

test("a record older than the reader's own lifetime is stale", () => {
  // The exact 2026-08-03 shape: reader SIGTERMed at 10m, record still "running".
  assert.equal(at({ id: "j34", status: "running", lastEventAt: ago(34) }).stale, true);
});

test("healthy long-running work is not flagged", () => {
  // The false positive that would make operators ignore the warning entirely.
  assert.equal(at({ id: "j3", status: "running", lastEventAt: ago(3) }).stale, false);
});

test("the threshold is closed at exactly 10 minutes", () => {
  const justUnder = new Date(NOW - (DEFAULT_STALE_AFTER_MS - 1000)).toISOString();
  const exactly = new Date(NOW - DEFAULT_STALE_AFTER_MS).toISOString();
  assert.equal(at({ id: "j9", status: "running", lastEventAt: justUnder }).stale, false);
  assert.equal(at({ id: "j10", status: "running", lastEventAt: exactly }).stale, true);
});

test("terminal jobs are never stale, however old", () => {
  assert.equal(at({ id: "jc", status: "completed", lastEventAt: ago(600) }), null);
  assert.equal(at({ id: "jf", status: "failed", lastEventAt: ago(600) }), null);
});

test("records written before the heartbeat existed still classify", () => {
  // Every job on disk today predates lastEventAt; falling over on them would
  // mean the guard only works for incidents that have not happened yet.
  assert.equal(at({ id: "jo", status: "running", startedAt: ago(40) }).stale, true);
  assert.equal(at({ id: "jn", status: "running" }).stale, true);
});

test("age comes from the heartbeat, not from how long the job has existed", () => {
  const job = { id: "jh", status: "running", createdAt: ago(300), lastEventAt: ago(1) };
  assert.equal(at(job).stale, false);
});

test("assessJobs reports only the genuinely stale entries", () => {
  const stale = assessJobs(
    [
      { id: "a", status: "running", lastEventAt: ago(34) },
      { id: "b", status: "running", lastEventAt: ago(2) },
      { id: "c", status: "completed", lastEventAt: ago(99) },
      { id: "d", status: "running", lastEventAt: ago(22), threadId: "019fc685-2370-7201-a92c-60bb9d491896" },
    ],
    { now: NOW },
  );
  assert.deepEqual(stale.map((entry) => entry.id), ["a", "d"]);
});

test("the warning refuses to claim the job is dead", () => {
  const stale = assessJobs(
    [{ id: "d", status: "running", lastEventAt: ago(22), threadId: "019fc685" }],
    { now: NOW },
  );
  const text = formatStaleWarning(stale);
  assert.match(text, /does NOT prove the job died/);
  assert.match(text, /check the rollout for thread 019fc685/);
  assert.equal(formatStaleWarning([]), "");
});
