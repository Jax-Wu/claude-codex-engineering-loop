#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  artifactPaths,
  atomicWriteJson,
  findProjectRoot,
  parseArgs,
  pathFromRoot,
  readActiveRun,
  setActiveRun,
  transition,
  writeRun,
} from "./lib.mjs";

const MAX_CAPTURE_BYTES = 256_000;

function packageManager(root) {
  if (existsSync(join(root, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (existsSync(join(root, "yarn.lock"))) {
    return "yarn";
  }
  if (
    existsSync(join(root, "bun.lock")) ||
    existsSync(join(root, "bun.lockb"))
  ) {
    return "bun";
  }
  return "npm";
}

function scriptCommand(manager, script) {
  if (manager === "npm") {
    return script === "test" ? ["npm", "test"] : ["npm", "run", script];
  }
  if (manager === "yarn") {
    return ["yarn", script];
  }
  if (manager === "pnpm") {
    return ["pnpm", "run", script];
  }
  return ["bun", "run", script];
}

export function discoverGates(root) {
  const packageFile = join(root, "package.json");
  if (existsSync(packageFile)) {
    const pkg = JSON.parse(readFileSync(packageFile, "utf8"));
    const scripts = pkg.scripts ?? {};
    const manager = packageManager(root);
    const names = ["typecheck", "lint", "test", "build"];
    return names
      .filter((name) => typeof scripts[name] === "string")
      .map((name) => ({
        name,
        command: scriptCommand(manager, name),
        timeoutSeconds: name === "test" || name === "build" ? 900 : 300,
        required: true,
        source: "package.json",
      }));
  }
  if (existsSync(join(root, "Cargo.toml"))) {
    return [
      {
        name: "cargo-check",
        command: ["cargo", "check"],
        timeoutSeconds: 600,
        required: true,
        source: "Cargo.toml",
      },
      {
        name: "cargo-test",
        command: ["cargo", "test"],
        timeoutSeconds: 900,
        required: true,
        source: "Cargo.toml",
      },
    ];
  }
  if (existsSync(join(root, "go.mod"))) {
    return [
      {
        name: "go-test",
        command: ["go", "test", "./..."],
        timeoutSeconds: 900,
        required: true,
        source: "go.mod",
      },
    ];
  }
  return [];
}

export function validateGate(gate, index) {
  const prefix = `gates[${index}]`;
  if (!gate || typeof gate !== "object" || Array.isArray(gate)) {
    throw new Error(`${prefix} must be an object.`);
  }
  if (typeof gate.name !== "string" || gate.name.trim() === "") {
    throw new Error(`${prefix}.name must be a non-empty string.`);
  }
  if (
    !Array.isArray(gate.command) ||
    gate.command.length === 0 ||
    gate.command.some((part) => typeof part !== "string" || part === "")
  ) {
    throw new Error(
      `${prefix}.command must be a non-empty argv array. Shell command strings are not allowed.`,
    );
  }
  if (
    gate.timeoutSeconds !== undefined &&
    (!Number.isFinite(gate.timeoutSeconds) || gate.timeoutSeconds <= 0)
  ) {
    throw new Error(`${prefix}.timeoutSeconds must be a positive number.`);
  }
  if (gate.required !== undefined && typeof gate.required !== "boolean") {
    throw new Error(`${prefix}.required must be boolean.`);
  }
  return {
    name: gate.name,
    command: gate.command,
    timeoutSeconds: gate.timeoutSeconds ?? 600,
    required: gate.required ?? true,
    source: gate.source ?? "config",
  };
}

function appendLimited(current, chunk) {
  const combined = current + chunk;
  if (Buffer.byteLength(combined, "utf8") <= MAX_CAPTURE_BYTES) {
    return combined;
  }
  const buffer = Buffer.from(combined, "utf8");
  return `${buffer.subarray(0, MAX_CAPTURE_BYTES).toString("utf8")}\n...[output truncated]`;
}

export function runGate(root, gate) {
  return new Promise((resolvePromise) => {
    const [command, ...args] = gate.command;
    const startedAt = new Date();
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1500).unref();
    }, gate.timeoutSeconds * 1000);

    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk.toString("utf8"));
    });

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolvePromise({
        name: gate.name,
        command: gate.command,
        required: gate.required,
        source: gate.source,
        status: result.status,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        stdout,
        stderr,
        error: result.error ?? null,
      });
    };

    child.on("error", (error) => {
      finish({
        status: "failed",
        exitCode: null,
        signal: null,
        error: error.message,
      });
    });
    child.on("close", (code, signal) => {
      finish({
        status: !timedOut && code === 0 ? "passed" : "failed",
        exitCode: code,
        signal,
        error: timedOut ? `Timed out after ${gate.timeoutSeconds}s.` : null,
      });
    });
  });
}

export async function executeGates(argv, cwd = process.cwd()) {
  const { flags } = parseArgs(argv);
  const root = findProjectRoot(
    typeof flags.cwd === "string" ? flags.cwd : cwd,
  );
  const state = readActiveRun(root);
  if (state.status !== "VERIFYING") {
    throw new Error(`Gates can only run in VERIFYING, not ${state.status}.`);
  }
  const configured = state.config.gates;
  const rawGates = configured ?? discoverGates(root);
  const gates = rawGates.map(validateGate);
  const results = [];
  for (const gate of gates) {
    results.push(await runGate(root, gate));
  }
  const evidence = {
    schemaVersion: 1,
    runId: state.runId,
    fixRound: state.fixRound,
    discovered: configured === null,
    noGatesConfigured: gates.length === 0,
    results,
    requiredPassed: results
      .filter((gate) => gate.required)
      .every((gate) => gate.status === "passed"),
    createdAt: new Date().toISOString(),
  };
  const target = artifactPaths(root, state).gatesPath;
  atomicWriteJson(target, evidence);
  state.artifacts.gates = pathFromRoot(root, target);
  writeRun(root, state);
  setActiveRun(root, state);
  transition(
    root,
    state,
    "REVIEWING",
    evidence.requiredPassed
      ? "Deterministic gates completed."
      : "One or more required deterministic gates failed.",
  );
  return evidence;
}

async function main() {
  try {
    const result = await executeGates(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`,
    );
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
