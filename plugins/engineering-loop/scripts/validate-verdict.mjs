#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const VERDICTS = new Set(["PASS", "FIX_REQUIRED", "HUMAN_REQUIRED"]);
const SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const CONFIDENCE = new Set(["high", "medium", "low"]);
const ACCEPTANCE_STATUS = new Set(["PASS", "FAIL", "UNKNOWN"]);
const TOP_LEVEL_KEYS = new Set([
  "verdict",
  "summary",
  "issues",
  "acceptance",
  "scope_drift",
  "confidence",
]);
const ISSUE_KEYS = new Set([
  "id",
  "severity",
  "blocking",
  "category",
  "file",
  "line",
  "evidence",
  "required_fix",
  "acceptance_test",
]);
const ACCEPTANCE_KEYS = new Set(["id", "status", "evidence"]);

function requireString(value, label, errors, options = {}) {
  if (typeof value !== "string" || (!options.allowEmpty && value.trim() === "")) {
    errors.push(`${label} must be a non-empty string.`);
  }
}

export function validateVerdictObject(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["Verdict must be a JSON object."] };
  }
  for (const key of Object.keys(value)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      errors.push(`Unexpected top-level property: ${key}.`);
    }
  }

  if (!VERDICTS.has(value.verdict)) {
    errors.push("verdict must be PASS, FIX_REQUIRED, or HUMAN_REQUIRED.");
  }
  requireString(value.summary, "summary", errors);
  if (!Array.isArray(value.issues)) {
    errors.push("issues must be an array.");
  }
  if (!Array.isArray(value.acceptance)) {
    errors.push("acceptance must be an array.");
  }
  if (!Array.isArray(value.scope_drift)) {
    errors.push("scope_drift must be an array.");
  }
  if (!CONFIDENCE.has(value.confidence)) {
    errors.push("confidence must be high, medium, or low.");
  }

  const issueIds = new Set();
  for (const [index, issue] of (value.issues ?? []).entries()) {
    const prefix = `issues[${index}]`;
    if (!issue || typeof issue !== "object" || Array.isArray(issue)) {
      errors.push(`${prefix} must be an object.`);
      continue;
    }
    for (const key of Object.keys(issue)) {
      if (!ISSUE_KEYS.has(key)) {
        errors.push(`${prefix} has unexpected property: ${key}.`);
      }
    }
    requireString(issue.id, `${prefix}.id`, errors);
    if (typeof issue.id === "string") {
      if (issueIds.has(issue.id)) {
        errors.push(`${prefix}.id duplicates ${issue.id}.`);
      }
      issueIds.add(issue.id);
    }
    if (!SEVERITIES.has(issue.severity)) {
      errors.push(`${prefix}.severity must be critical, high, medium, or low.`);
    }
    if (typeof issue.blocking !== "boolean") {
      errors.push(`${prefix}.blocking must be boolean.`);
    }
    requireString(issue.category, `${prefix}.category`, errors);
    requireString(issue.file, `${prefix}.file`, errors);
    if (!Object.hasOwn(issue, "line")) {
      errors.push(`${prefix}.line is required and may be null.`);
    } else if (
      issue.line !== null &&
      issue.line !== undefined &&
      (!Number.isInteger(issue.line) || issue.line < 1)
    ) {
      errors.push(`${prefix}.line must be null or a positive integer.`);
    }
    requireString(issue.evidence, `${prefix}.evidence`, errors);
    requireString(issue.required_fix, `${prefix}.required_fix`, errors);
    requireString(issue.acceptance_test, `${prefix}.acceptance_test`, errors);
  }

  const acceptanceIds = new Set();
  for (const [index, item] of (value.acceptance ?? []).entries()) {
    const prefix = `acceptance[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`${prefix} must be an object.`);
      continue;
    }
    for (const key of Object.keys(item)) {
      if (!ACCEPTANCE_KEYS.has(key)) {
        errors.push(`${prefix} has unexpected property: ${key}.`);
      }
    }
    requireString(item.id, `${prefix}.id`, errors);
    if (typeof item.id === "string") {
      if (acceptanceIds.has(item.id)) {
        errors.push(`${prefix}.id duplicates ${item.id}.`);
      }
      acceptanceIds.add(item.id);
    }
    if (!ACCEPTANCE_STATUS.has(item.status)) {
      errors.push(`${prefix}.status must be PASS, FAIL, or UNKNOWN.`);
    }
    requireString(item.evidence, `${prefix}.evidence`, errors);
  }

  const blocking = (value.issues ?? []).filter((issue) => issue?.blocking === true);
  const failedAcceptance = (value.acceptance ?? []).filter(
    (item) => item?.status !== "PASS",
  );
  if (
    value.verdict === "PASS" &&
    (blocking.length > 0 ||
      failedAcceptance.length > 0 ||
      (value.scope_drift ?? []).length > 0)
  ) {
    errors.push(
      "PASS is invalid while blocking issues, non-passing acceptance criteria, or scope drift remain.",
    );
  }
  if (value.verdict === "FIX_REQUIRED" && blocking.length === 0) {
    errors.push("FIX_REQUIRED must include at least one blocking issue.");
  }
  for (const [index, drift] of (value.scope_drift ?? []).entries()) {
    requireString(drift, `scope_drift[${index}]`, errors);
  }

  return { ok: errors.length === 0, errors };
}

function main() {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write("Usage: validate-verdict.mjs <verdict.json>\n");
    process.exit(2);
  }
  let value;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    process.stderr.write(`Invalid JSON: ${error.message}\n`);
    process.exit(1);
  }
  const result = validateVerdictObject(value);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
