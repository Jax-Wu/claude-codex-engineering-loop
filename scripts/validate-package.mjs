#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const plugin = join(root, "plugins", "engineering-loop");
const errors = [];
let jsonCount = 0;
let scriptCount = 0;
let markdownCount = 0;

function walk(directory) {
  for (const name of readdirSync(directory)) {
    const file = join(directory, name);
    const stats = statSync(file);
    if (stats.isDirectory()) {
      walk(file);
    } else {
      checkFile(file);
    }
  }
}

function checkFrontmatter(file, text) {
  if (!text.startsWith("---\n")) {
    errors.push(`${file}: missing YAML frontmatter.`);
    return;
  }
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) {
    errors.push(`${file}: unterminated YAML frontmatter.`);
    return;
  }
  const frontmatter = text.slice(4, end);
  if (!/^name:\s*\S+/mu.test(frontmatter)) {
    errors.push(`${file}: frontmatter has no name.`);
  }
  if (!/^description:\s*.+/mu.test(frontmatter)) {
    errors.push(`${file}: frontmatter has no description.`);
  }
}

function checkFile(file) {
  if (file.endsWith(".json")) {
    jsonCount += 1;
    try {
      JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      errors.push(`${file}: invalid JSON: ${error.message}`);
    }
  }
  if (file.endsWith(".mjs")) {
    scriptCount += 1;
    const result = spawnSync(process.execPath, ["--check", file], {
      encoding: "utf8",
      shell: false,
    });
    if (result.status !== 0) {
      errors.push(`${file}: ${result.stderr.trim()}`);
    }
  }
  if (file.endsWith(".md")) {
    markdownCount += 1;
    const text = readFileSync(file, "utf8");
    if (text.includes("TODO")) {
      errors.push(`${file}: contains TODO placeholder.`);
    }
    if (
      file.includes(`${join("skills", "")}`) ||
      file.includes(`${join("agents", "")}`)
    ) {
      checkFrontmatter(file, text);
    }
  }
}

walk(root);

const marketplace = JSON.parse(
  readFileSync(join(root, ".claude-plugin", "marketplace.json"), "utf8"),
);
const entry = marketplace.plugins.find((item) => item.name === "engineering-loop");
if (!entry) {
  errors.push("Marketplace has no engineering-loop entry.");
} else {
  const source = resolve(root, entry.source);
  if (!existsSync(join(source, ".claude-plugin", "plugin.json"))) {
    errors.push(`Marketplace source has no plugin manifest: ${source}`);
  }
  const manifest = JSON.parse(
    readFileSync(join(source, ".claude-plugin", "plugin.json"), "utf8"),
  );
  if (manifest.version !== entry.version) {
    errors.push(
      `Version mismatch: marketplace=${entry.version}, plugin=${manifest.version}`,
    );
  }
}

for (const skill of ["start", "status", "resume", "cancel"]) {
  if (!existsSync(join(plugin, "skills", skill, "SKILL.md"))) {
    errors.push(`Missing skill: ${skill}`);
  }
}
for (const required of [
  join("agents", "engineering-reviewer.md"),
  join("hooks", "hooks.json"),
  join("scripts", "controller.mjs"),
  join("scripts", "run-gates.mjs"),
  join("scripts", "collect-evidence.mjs"),
  join("scripts", "stop-guard.mjs"),
]) {
  if (!existsSync(join(plugin, required))) {
    errors.push(`Missing plugin component: ${required}`);
  }
}

if (errors.length > 0) {
  process.stderr.write(`${errors.map((error) => `- ${error}`).join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(
  `Package validation passed: ${jsonCount} JSON files, ${scriptCount} scripts, ${markdownCount} Markdown files.\n`,
);
