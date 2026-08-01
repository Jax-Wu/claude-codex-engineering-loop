#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  TERMINAL_STATES,
  WAITING_STATES,
  findProjectRoot,
  readActiveRun,
} from "./lib.mjs";

async function readStdin() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 1_000_000) {
      throw new Error("Hook input is too large.");
    }
  }
  return input.trim() ? JSON.parse(input) : {};
}

export function guardDecision(input) {
  if (input.stop_hook_active === true) {
    return null;
  }
  let root;
  try {
    root = findProjectRoot(input.cwd ?? process.cwd());
  } catch {
    return null;
  }
  let state;
  try {
    state = readActiveRun(root, { allowMissing: true });
  } catch {
    return null;
  }
  if (!state) {
    return null;
  }
  if (
    state.ownerSessionId &&
    input.session_id &&
    state.ownerSessionId !== input.session_id
  ) {
    return null;
  }
  if (TERMINAL_STATES.has(state.status) || WAITING_STATES.has(state.status)) {
    return null;
  }
  return {
    decision: "block",
    reason: `Engineering loop ${state.runId} is active in ${state.status}. Run /engineering-loop:resume or continue the orchestration procedure from ${root}/${state.runDir}/run.json. Do not start a duplicate Codex task.`,
  };
}

async function main() {
  try {
    const input = await readStdin();
    const decision = guardDecision(input);
    if (decision) {
      process.stdout.write(`${JSON.stringify(decision)}\n`);
    }
  } catch {
    // A guard must fail open; malformed state must not trap the user's session.
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
