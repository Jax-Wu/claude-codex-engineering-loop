import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { executeController } from "../plugins/engineering-loop/scripts/controller.mjs";
import { executeGates } from "../plugins/engineering-loop/scripts/run-gates.mjs";
import { executeCollect } from "../plugins/engineering-loop/scripts/collect-evidence.mjs";
import { cleanupRepo, makeRepo } from "./helpers.mjs";

function writeArtifact(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
}

test("runs implementation, review, fix, and pass to completion", async (t) => {
  const root = makeRepo({
    packageJson: {
      name: "fixture",
      version: "1.0.0",
      scripts: {
        test: "node -e \"process.exit(0)\"",
      },
    },
  });
  t.after(() => cleanupRepo(root));

  let status = executeController(
    [
      "init",
      "--cwd",
      root,
      "--goal",
      "Add a safe greeting helper",
      "--profile",
      "fast",
      "--skip-codex-check",
    ],
    root,
  );
  assert.equal(status.status, "PLANNING");
  writeArtifact(
    status.planPath,
    "# Plan\n\n- AC-001: greeting helper returns hello\n",
  );
  status = executeController(
    [
      "plan-ready",
      "--cwd",
      root,
      "--file",
      status.planPath,
      "--approval",
      "skip",
    ],
    root,
  );
  assert.equal(status.status, "EXECUTING");

  writeFileSync(
    join(root, "src", "greeting.js"),
    "export const greeting = () => 'hello';\n",
    "utf8",
  );
  writeArtifact(status.current.executionReportPath, "Implemented greeting.\n");
  status = executeController(
    [
      "execution-complete",
      "--cwd",
      root,
      "--report-file",
      status.current.executionReportPath,
    ],
    root,
  );
  assert.equal(status.status, "VERIFYING");

  const firstGates = await executeGates(["--cwd", root], root);
  assert.equal(firstGates.requiredPassed, true);
  const firstEvidence = executeCollect(["--cwd", root], root);
  assert.equal(firstEvidence.ok, true);
  assert.ok(firstEvidence.changedFiles.includes("src/greeting.js"));

  const firstVerdict = {
    verdict: "FIX_REQUIRED",
    summary: "The helper needs an explicit test.",
    issues: [
      {
        id: "R1-001",
        severity: "high",
        blocking: true,
        category: "tests",
        file: "src/greeting.test.js",
        line: 1,
        evidence: "No test exercises AC-001.",
        required_fix: "Add a focused test.",
        acceptance_test: "The test asserts the helper returns hello.",
      },
    ],
    acceptance: [
      {
        id: "AC-001",
        status: "FAIL",
        evidence: "Implementation exists but lacks direct proof.",
      },
    ],
    scope_drift: [],
    confidence: "high",
  };
  writeArtifact(firstEvidence.verdictPath, `${JSON.stringify(firstVerdict)}\n`);
  status = executeController(
    ["verdict", "--cwd", root, "--file", firstEvidence.verdictPath],
    root,
  );
  assert.equal(status.status, "FIXING");
  assert.equal(status.fixRound, 1);
  assert.equal(existsSync(status.current.fixPacketPath), true);
  assert.match(
    readFileSync(status.current.fixPacketPath, "utf8"),
    /R1-001/u,
  );

  writeFileSync(
    join(root, "src", "greeting.test.js"),
    "import { greeting } from './greeting.js';\nif (greeting() !== 'hello') process.exit(1);\n",
    "utf8",
  );
  writeArtifact(status.current.executionReportPath, "Added greeting test.\n");
  status = executeController(
    [
      "execution-complete",
      "--cwd",
      root,
      "--report-file",
      status.current.executionReportPath,
    ],
    root,
  );
  assert.equal(status.status, "VERIFYING");
  await executeGates(["--cwd", root], root);
  const secondEvidence = executeCollect(["--cwd", root], root);

  const finalVerdict = {
    verdict: "PASS",
    summary: "The acceptance criterion is met and required gates pass.",
    issues: [],
    acceptance: [
      {
        id: "AC-001",
        status: "PASS",
        evidence: "src/greeting.js and src/greeting.test.js",
      },
    ],
    scope_drift: [],
    confidence: "high",
  };
  writeArtifact(secondEvidence.verdictPath, `${JSON.stringify(finalVerdict)}\n`);
  status = executeController(
    ["verdict", "--cwd", root, "--file", secondEvidence.verdictPath],
    root,
  );
  assert.equal(status.status, "DONE");
  assert.equal(existsSync(join(root, ".engineering-loop", "active.json")), false);
});

test("rejects incomplete acceptance coverage and non-blocking threshold issues", async (t) => {
  const root = makeRepo();
  t.after(() => cleanupRepo(root));

  let status = executeController(
    [
      "init",
      "--cwd",
      root,
      "--goal",
      "Review policy fixture",
      "--profile",
      "standard",
      "--skip-codex-check",
    ],
    root,
  );
  writeArtifact(
    status.planPath,
    "# Plan\n\n- AC-001: first criterion\n- AC-002: second criterion\n",
  );
  status = executeController(
    [
      "plan-ready",
      "--cwd",
      root,
      "--file",
      status.planPath,
      "--approval",
      "skip",
    ],
    root,
  );
  writeArtifact(status.current.executionReportPath, "Implementation complete.\n");
  executeController(
    [
      "execution-complete",
      "--cwd",
      root,
      "--report-file",
      status.current.executionReportPath,
    ],
    root,
  );
  await executeGates(["--cwd", root], root);
  const evidence = executeCollect(["--cwd", root], root);

  const missingAcceptance = {
    verdict: "PASS",
    summary: "Only one criterion was reviewed.",
    issues: [],
    acceptance: [
      {
        id: "AC-001",
        status: "PASS",
        evidence: "Reviewed.",
      },
    ],
    scope_drift: [],
    confidence: "high",
  };
  writeArtifact(
    evidence.verdictPath,
    `${JSON.stringify(missingAcceptance)}\n`,
  );
  assert.throws(
    () =>
      executeController(
        ["verdict", "--cwd", root, "--file", evidence.verdictPath],
        root,
      ),
    /did not cover acceptance criteria AC-002/u,
  );

  const nonBlockingHigh = {
    verdict: "FIX_REQUIRED",
    summary: "A high-severity issue was incorrectly marked non-blocking.",
    issues: [
      {
        id: "R1-001",
        severity: "high",
        blocking: false,
        category: "correctness",
        file: "src/example.js",
        line: null,
        evidence: "The required behavior is absent.",
        required_fix: "Implement the required behavior.",
        acceptance_test: "Add a focused test.",
      },
      {
        id: "R1-002",
        severity: "low",
        blocking: true,
        category: "maintainability",
        file: "src/example.js",
        line: null,
        evidence: "A secondary cleanup remains.",
        required_fix: "Apply the cleanup.",
        acceptance_test: "Confirm the focused test remains readable.",
      },
    ],
    acceptance: [
      {
        id: "AC-001",
        status: "FAIL",
        evidence: "Not implemented.",
      },
      {
        id: "AC-002",
        status: "PASS",
        evidence: "Reviewed.",
      },
    ],
    scope_drift: [],
    confidence: "high",
  };
  writeArtifact(evidence.verdictPath, `${JSON.stringify(nonBlockingHigh)}\n`);
  assert.throws(
    () =>
      executeController(
        ["verdict", "--cwd", root, "--file", evidence.verdictPath],
        root,
      ),
    /requires high\+ issues to block/u,
  );
});
