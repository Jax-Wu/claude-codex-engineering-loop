#!/usr/bin/env node
// Check every bundle under patches/ against the installed plugin cache.
//
// Exists so adding a second patch cannot quietly fall outside the check. Each
// bundle owns its own apply.mjs and manifest; this just runs them all and
// reports the worst outcome.
//
//   node scripts/check-patches.mjs            # check only
//   node scripts/check-patches.mjs --apply    # install anything missing
//
// Exit 0 every bundle installed and current, 1 something is not installed,
// 2 a bundle refused (upstream drifted, wrong plugin version, not installed).

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const patchesDir = join(root, "patches");
const passThrough = process.argv.slice(2);

if (!existsSync(patchesDir)) {
  process.stdout.write("no patches/ directory; nothing to check\n");
  process.exit(0);
}

const bundles = readdirSync(patchesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(patchesDir, entry.name, "apply.mjs")))
  .map((entry) => entry.name)
  .sort();

if (bundles.length === 0) {
  process.stdout.write("no patch bundles found\n");
  process.exit(0);
}

let worst = 0;
for (const bundle of bundles) {
  process.stdout.write(`\n== ${bundle}\n`);
  const run = spawnSync(
    process.execPath,
    [join(patchesDir, bundle, "apply.mjs"), ...passThrough],
    { stdio: "inherit" },
  );
  worst = Math.max(worst, run.status ?? 2);
}

process.stdout.write(`\n${bundles.length} bundle(s) checked\n`);
process.exit(worst);
