#!/usr/bin/env node
// Replay the stale-job guard into an installed openai-codex plugin cache.
//
// The guard lives in a directory Claude Code owns and rewrites on every plugin
// update, so the installed copy is disposable by design. This script is the
// non-disposable half: the reviewed content lives in this repo, and applying it
// is a hash-gated copy rather than a fuzzy patch.
//
//   node apply.mjs            # check only; exit 0 iff fully applied
//   node apply.mjs --apply    # install, refusing on any drift
//   node apply.mjs --lib-dir /path/to/scripts/lib   # explicit target
//
// Refusing is the point. If upstream changed either file, the correct move is to
// re-derive the patch against the new baseline by hand -- silently overwriting a
// newer upstream file with our 1.0.4 copy would reintroduce whatever upstream
// fixed in between, and would do it invisibly.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(fs.readFileSync(path.join(HERE, "manifest.json"), "utf8"));
const INSTALLED_PLUGINS = path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json");

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function parseArgs(argv) {
  const args = { apply: false, libDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--lib-dir") args.libDir = argv[++i] ?? null;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

// Resolve from the installed-plugin registry rather than a hardcoded path: the
// version is part of the cache directory name, so a hardcoded path would keep
// pointing at a stale version's directory long after it stopped being the live
// one -- exactly the "which copy is live" ambiguity this whole exercise removed.
function resolveLibDir() {
  if (!fs.existsSync(INSTALLED_PLUGINS)) {
    throw new Error(`no installed-plugin registry at ${INSTALLED_PLUGINS}`);
  }
  const registry = JSON.parse(fs.readFileSync(INSTALLED_PLUGINS, "utf8"));
  const entries = registry?.plugins?.[MANIFEST.target.plugin];
  const entry = Array.isArray(entries) ? entries[0] : null;
  if (!entry?.installPath) {
    throw new Error(`${MANIFEST.target.plugin} is not installed`);
  }
  if (entry.version !== MANIFEST.target.pluginVersion) {
    throw new Error(
      `installed ${MANIFEST.target.plugin} is ${entry.version}, this patch was derived against ` +
      `${MANIFEST.target.pluginVersion}. Re-derive against the new baseline; do not force it.`
    );
  }
  return path.join(entry.installPath, MANIFEST.target.libDir);
}

// baseline -> upstream, untouched, ours can go on top
// patched  -> already ours
// absent   -> a new file we add, not there yet
// drifted  -> anything else; never overwrite
function classify(libDir, spec) {
  const target = path.join(libDir, spec.name);
  if (!fs.existsSync(target)) {
    return { spec, target, state: spec.mode === "add" ? "absent" : "drifted", detail: "missing" };
  }
  const digest = sha256(target);
  if (digest === spec.patchedSha256) return { spec, target, state: "patched", digest };
  if (spec.baselineSha256 && digest === spec.baselineSha256) return { spec, target, state: "baseline", digest };
  return { spec, target, state: "drifted", digest };
}

function timestamp() {
  const iso = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  return iso.replace("T", "-");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      "usage: apply.mjs [--apply] [--lib-dir <path>]\n" +
      "  (no flags)  check only; exit 0 iff every file is already the patched copy\n" +
      "  --apply     copy the reviewed files in, refusing if upstream drifted\n"
    );
    return 0;
  }

  const libDir = args.libDir ?? resolveLibDir();
  process.stdout.write(`target: ${libDir}\n`);

  const results = MANIFEST.files.map((spec) => classify(libDir, spec));
  for (const r of results) {
    process.stdout.write(`  ${r.spec.name.padEnd(20)} ${r.state}\n`);
  }

  const drifted = results.filter((r) => r.state === "drifted");
  if (drifted.length > 0) {
    process.stderr.write(
      `\nREFUSING: ${drifted.length} file(s) match neither the ${MANIFEST.target.pluginVersion} baseline ` +
      `nor our patched copy.\nUpstream changed underneath this patch. Re-derive it against the new ` +
      `baseline by hand:\n` +
      drifted.map((r) => `  ${r.target}${r.digest ? ` (sha256 ${r.digest})` : ""}`).join("\n") + "\n"
    );
    return 2;
  }

  const pending = results.filter((r) => r.state !== "patched");
  if (pending.length === 0) {
    process.stdout.write("\nguard is installed and current.\n");
    return 0;
  }

  if (!args.apply) {
    process.stdout.write(`\n${pending.length} file(s) not installed. Re-run with --apply.\n`);
    return 1;
  }

  const backupDir = path.join(libDir, `.backup-${timestamp()}-stale-guard`);
  for (const r of pending) {
    if (r.state === "baseline") {
      fs.mkdirSync(backupDir, { recursive: true });
      fs.copyFileSync(r.target, path.join(backupDir, r.spec.name));
    }
    fs.copyFileSync(path.join(HERE, "patched", r.spec.name), r.target);
    process.stdout.write(`  installed ${r.spec.name}\n`);
  }
  if (fs.existsSync(backupDir)) {
    process.stdout.write(`\nupstream copies backed up to ${backupDir}\n`);
  }
  process.stdout.write("guard installed.\n");
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
