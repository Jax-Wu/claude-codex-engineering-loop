import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export function command(root, executable, args) {
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(
      `${executable} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

export function makeRepo(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "engineering-loop-test-"));
  command(root, "git", ["init", "-q"]);
  command(root, "git", ["config", "user.email", "test@example.com"]);
  command(root, "git", ["config", "user.name", "Engineering Loop Test"]);
  writeFileSync(join(root, "README.md"), "# Fixture\n", "utf8");
  if (options.packageJson) {
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify(options.packageJson, null, 2)}\n`,
      "utf8",
    );
  }
  mkdirSync(join(root, "src"), { recursive: true });
  command(root, "git", ["add", "."]);
  command(root, "git", ["commit", "-qm", "fixture"]);
  return root;
}

export function cleanupRepo(root) {
  rmSync(root, { recursive: true, force: true });
}
