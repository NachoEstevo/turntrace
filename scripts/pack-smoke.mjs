import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const npm = process.env.npm_execpath;
assert(npm, "Run npm run test:pack from the checkout");
const supplied = process.argv[2];
assert(process.argv.length <= 3, "Expected at most one tarball path");
const scratch = mkdtempSync(join(tmpdir(), "turntrace pack "));
const consumer = join(scratch, "consumer with spaces");
const fromRoot = relative(root, consumer);
assert(fromRoot.startsWith("..") || isAbsolute(fromRoot), "Choose a temp directory outside the checkout");

function run(command, args, { cwd = consumer, status = 0, offline = false } = {}) {
  const env = { ...process.env, npm_config_audit: "false", npm_config_fund: "false" };
  if (offline) {
    env.npm_config_offline = "true";
    env.npm_config_registry = "http://127.0.0.1:1/";
  }
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
  if (result.error) throw result.error;
  const output = result.stdout + result.stderr;
  assert.equal(result.status, status, args.join(" ") + "\n" + output);
  return output;
}

function cli(args, status = 0) {
  // npm resolves the binary installed in this consumer, including the Windows .cmd shim.
  return run(process.execPath, [npm, "run", "--silent", "turntrace", "--", ...args], { status, offline: true });
}

try {
  mkdirSync(consumer);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const archive = supplied ? resolve(supplied) : join(scratch, pkg.name + "-" + pkg.version + ".tgz");
  if (!supplied) {
    run(process.execPath, [npm, "pack", "--pack-destination", scratch], { cwd: root });
  }
  const entries = run("tar", ["-tzf", basename(archive)], { cwd: dirname(archive) }).trim().split(/\r?\n/);
  const required = [
    "package/package.json", "package/README.md", "package/LICENSE",
    "package/THIRD_PARTY_NOTICES.md", "package/notices/zod-MIT.txt",
    "package/docs/architecture.md", "package/docs/distribution.md",
    "package/examples/commit-first.buggy.json", "package/examples/recovery.idempotent.json",
    "package/dist/index.js", "package/dist/index.d.ts", "package/dist/cli/index.js",
  ];
  for (const path of required) assert(entries.includes(path), "Missing tar entry " + path);
  for (const path of entries) {
    const allowed = required.includes(path) || /^package\/dist\/(?:[\w-]+\/)*[\w-]+\.(?:js|d\.ts)$/.test(path);
    assert(allowed, "Unexpected tar entry " + path);
  }

  writeFileSync(join(consumer, "package.json"), JSON.stringify({
    name: "turntrace-pack-consumer", version: "1.0.0", private: true, scripts: { turntrace: "turntrace" },
  }));
  run(process.execPath, [npm, "install", "--ignore-scripts", "--omit=dev", archive]);
  const info = JSON.parse(readFileSync(join(consumer, "node_modules", "turntrace", "package.json"), "utf8"));
  assert.equal(info.version, pkg.version);
  assert.equal(info.private, true);
  assert.equal(info.license, "Apache-2.0");
  assert.equal(info.exports["."].types, "./dist/index.d.ts");

  // The consumer gets production dependencies only. Keep TypeScript in a separate
  // tooling directory when the checkout does not already have its compiler installed.
  let tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(tsc)) {
    const tooling = join(scratch, "tools");
    mkdirSync(tooling);
    run(process.execPath, [npm, "install", "--no-save", "--ignore-scripts", "--prefix", tooling,
      "typescript@" + pkg.devDependencies.typescript]);
    tsc = join(tooling, "node_modules", "typescript", "bin", "tsc");
  }
  writeFileSync(join(consumer, "consumer.mts"), [
    'import { createTrace, replayTrace, type Trace } from "turntrace";',
    'const trace: Trace = createTrace("fixed", "commit-first");',
    'const replayed: Trace = replayTrace(trace);',
    'void replayed.result.verdict;',
  ].join("\n"));
  run(process.execPath, [tsc, "--noEmit", "--strict", "--module", "NodeNext", "--target", "ES2023",
    "consumer.mts"], { offline: true });

  assert.match(cli(["--help"]), /turntrace replay/i);
  assert.match(cli(["demo", "--order", "commit-first", "--policy", "fixed"]), /PASS/i);
  assert.match(cli(["recovery", "--provider", "opaque"]), /unknown \(human review/i);
  const examples = join("node_modules", "turntrace", "examples");
  const first = join(examples, "commit-first.buggy.json");
  const second = join(examples, "recovery.idempotent.json");
  assert.match(cli(["replay", first], 1), /Verified replay/i);
  assert.match(cli(["replay", second]), /Verified replay/i);
  // The public ESM entry point must work with Node's package resolver in a fresh project.
  run(process.execPath, ["--input-type=module", "--eval", `
    import assert from 'node:assert/strict';
    import { createTrace, replayTrace } from 'turntrace';
    const trace = createTrace('fixed', 'commit-first');
    assert.equal(replayTrace(trace).result.verdict, 'pass');
  `], { offline: true });

  const changed = JSON.parse(readFileSync(join(consumer, second), "utf8"));
  changed.result.verdict = "unverified";
  writeFileSync(join(consumer, "changed trace.json"), JSON.stringify(changed));
  assert.match(cli(["replay", "changed trace.json"], 2), /invalid|diverg|mismatch/i);
  console.log("Tar contents, production install, npm bin, ESM API, declarations and offline replays passed.");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
