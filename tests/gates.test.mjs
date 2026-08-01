import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { executeController } from "../plugins/engineering-loop/scripts/controller.mjs";
import {
  discoverGates,
  executeGates,
  validateGate,
} from "../plugins/engineering-loop/scripts/run-gates.mjs";
import { executeCollect } from "../plugins/engineering-loop/scripts/collect-evidence.mjs";
import { cleanupRepo, makeRepo } from "./helpers.mjs";

test("discovers package scripts and rejects shell command strings", (t) => {
  const root = makeRepo({
    packageJson: {
      name: "fixture",
      version: "1.0.0",
      scripts: {
        lint: "node -e \"process.exit(0)\"",
        test: "node -e \"process.exit(0)\"",
      },
    },
  });
  t.after(() => cleanupRepo(root));
  assert.deepEqual(
    discoverGates(root).map((gate) => gate.name),
    ["lint", "test"],
  );
  assert.throws(
    () => validateGate({ name: "unsafe", command: "npm test" }, 0),
    /argv array/u,
  );
});

test("failed required gates prevent PASS", async (t) => {
  const root = makeRepo({
    packageJson: {
      name: "fixture",
      version: "1.0.0",
      scripts: {
        test: "node -e \"process.exit(2)\"",
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
      "Change fixture",
      "--profile",
      "fast",
      "--skip-codex-check",
    ],
    root,
  );
  writeFileSync(status.planPath, "# Plan\n\n- AC-001: fixture changes\n", "utf8");
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
  writeFileSync(join(root, "src", "change.js"), "export default 1;\n", "utf8");
  mkdirSync(dirname(status.current.executionReportPath), { recursive: true });
  writeFileSync(status.current.executionReportPath, "Changed fixture.\n", "utf8");
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
  const gates = await executeGates(["--cwd", root], root);
  assert.equal(gates.requiredPassed, false);
  const evidence = executeCollect(["--cwd", root], root);
  const verdict = {
    verdict: "PASS",
    summary: "Incorrect optimistic result.",
    issues: [],
    acceptance: [
      {
        id: "AC-001",
        status: "PASS",
        evidence: "src/change.js",
      },
    ],
    scope_drift: [],
    confidence: "low",
  };
  writeFileSync(evidence.verdictPath, `${JSON.stringify(verdict)}\n`, "utf8");
  assert.throws(
    () =>
      executeController(
        ["verdict", "--cwd", root, "--file", evidence.verdictPath],
        root,
      ),
    /PASS rejected/u,
  );
});
