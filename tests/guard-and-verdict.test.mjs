import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { executeController } from "../plugins/engineering-loop/scripts/controller.mjs";
import { guardDecision } from "../plugins/engineering-loop/scripts/stop-guard.mjs";
import { validateVerdictObject } from "../plugins/engineering-loop/scripts/validate-verdict.mjs";
import { cleanupRepo, makeRepo } from "./helpers.mjs";

test("Stop guard blocks active work and allows waiting states", (t) => {
  const root = makeRepo();
  t.after(() => cleanupRepo(root));
  let status = executeController(
    [
      "init",
      "--cwd",
      root,
      "--goal",
      "Plan fixture",
      "--profile",
      "strict",
      "--session-id",
      "session-a",
      "--skip-codex-check",
    ],
    root,
  );
  assert.equal(
    guardDecision({ cwd: root, session_id: "session-a" })?.decision,
    "block",
  );
  assert.equal(
    guardDecision({ cwd: root, session_id: "session-b" }),
    null,
  );
  assert.equal(
    guardDecision({
      cwd: root,
      session_id: "session-a",
      stop_hook_active: true,
    }),
    null,
  );
  writeFileSync(status.planPath, "# Plan\n\n- AC-001: planned\n", "utf8");
  status = executeController(
    [
      "plan-ready",
      "--cwd",
      root,
      "--file",
      status.planPath,
      "--approval",
      "required",
    ],
    root,
  );
  assert.equal(status.status, "PLAN_APPROVAL");
  assert.equal(guardDecision({ cwd: root, session_id: "session-a" }), null);
});

test("verdict validation enforces blocking and acceptance invariants", () => {
  const invalidPass = validateVerdictObject({
    verdict: "PASS",
    summary: "Looks fine.",
    issues: [
      {
        id: "R1-001",
        severity: "high",
        blocking: true,
        category: "correctness",
        file: "src/a.js",
        line: 1,
        evidence: "Broken.",
        required_fix: "Fix it.",
        acceptance_test: "Test it.",
      },
    ],
    acceptance: [
      {
        id: "AC-001",
        status: "FAIL",
        evidence: "Not met.",
      },
    ],
    scope_drift: [],
    confidence: "high",
  });
  assert.equal(invalidPass.ok, false);
  assert.match(invalidPass.errors.join(" "), /PASS is invalid/u);

  const validPass = validateVerdictObject({
    verdict: "PASS",
    summary: "Acceptance is met.",
    issues: [],
    acceptance: [
      {
        id: "AC-001",
        status: "PASS",
        evidence: "Focused test passes.",
      },
    ],
    scope_drift: [],
    confidence: "high",
  });
  assert.equal(validPass.ok, true);
});
