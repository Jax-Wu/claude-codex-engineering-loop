// Staleness reporting for tracked jobs.
//
// Why this exists: on 2026-08-03 three jobs were believed to have hung for
// 15/34/22 minutes. Rollout files later showed at least two of them had finished
// normally minutes earlier -- what actually broke was that the companion record
// stayed "running" forever, because the writer only persisted terminal state
// after its await returned and the foreground reader had been SIGTERMed at ten
// minutes. Nothing ever checked how old a "running" record was, so 34 minutes of
// silence stayed quiet and the operator diagnosed a hang that had not happened.
//
// This module only *describes* staleness. It never cancels, never mutates a job,
// and never decides on the human's behalf -- a job that looks stale may simply be
// on a long tool call, and killing it automatically would turn a reporting bug
// into data loss.

// Chosen against the observed failure, not as a round number. The dispatcher's
// own 120s likelyDetached threshold answers a narrower question ("should I keep
// streaming?") and is too twitchy here: a single long build or test step exceeds
// it while the job is perfectly healthy, and this guard is consulted on
// status/resume/Stop, where crying wolf trains people to ignore it. Ten minutes
// is the shortest interval that is unambiguously wrong -- it is exactly when the
// foreground reader gets killed, so a record older than that has already outlived
// the mechanism meant to update it.
export const DEFAULT_STALE_AFTER_MS = 10 * 60 * 1000;

const ACTIVE_STATUSES = new Set(["running", "queued", "starting"]);

export function isActiveStatus(status) {
  return ACTIVE_STATUSES.has(String(status ?? "").toLowerCase());
}

// Prefer the heartbeat, then the coarser transition timestamps, then creation.
// Order matters: falling back to createdAt alone would flag a job as stale purely
// for being long-lived, which is the false positive that makes a guard useless.
export function lastActivityAt(job) {
  const candidates = [job?.lastEventAt, job?.updatedAt, job?.startedAt, job?.createdAt];
  for (const value of candidates) {
    if (!value) continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) {
      return { iso: value, ms };
    }
  }
  return null;
}

export function describeAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return `${Math.floor(ms / 1000)}s`;
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/**
 * Classify one job. Returns null when the job is terminal or not yet started,
 * since staleness is only meaningful for something claiming to be in progress.
 */
export function assessJob(job, options = {}) {
  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

  if (!job || !isActiveStatus(job.status)) {
    return null;
  }

  const activity = lastActivityAt(job);
  if (!activity) {
    return {
      id: job.id,
      stale: true,
      ageMs: null,
      age: "unknown",
      reason: "no usable timestamp on an active job record",
      lastActivityAt: null
    };
  }

  const ageMs = now - activity.ms;
  const stale = ageMs >= staleAfterMs;
  return {
    id: job.id,
    stale,
    ageMs,
    age: describeAge(ageMs),
    reason: stale
      ? `no event in ${describeAge(ageMs)}; the foreground reader is killed at 10m, so this record may have outlived its writer`
      : null,
    lastActivityAt: activity.iso,
    rolloutHint: stale && job.threadId
      ? `check the rollout for thread ${job.threadId} before assuming it is dead`
      : null
  };
}

export function assessJobs(jobs, options = {}) {
  return (Array.isArray(jobs) ? jobs : [])
    .map((job) => assessJob(job, options))
    .filter((entry) => entry && entry.stale);
}

/**
 * Human-facing warning block. Deliberately loud and deliberately non-committal
 * about what it means: the whole point of the 2026-08-03 post-mortem is that
 * "stale record" and "dead job" are different claims, and conflating them is
 * what produced a wrong diagnosis that survived in the DEVLOG for three days.
 */
export function formatStaleWarning(entries) {
  if (!entries || entries.length === 0) return "";
  const lines = [
    "",
    `WARNING: ${entries.length} job record(s) look detached/stale.`,
    "A stale record does NOT prove the job died -- it proves nothing has updated",
    "the record. Check the rollout before cancelling anything.",
    ""
  ];
  for (const entry of entries) {
    lines.push(`  - ${entry.id}: ${entry.reason}`);
    if (entry.lastActivityAt) lines.push(`      last event: ${entry.lastActivityAt}`);
    if (entry.rolloutHint) lines.push(`      ${entry.rolloutHint}`);
  }
  lines.push("");
  return lines.join("\n");
}
