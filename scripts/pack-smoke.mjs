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

function run(command, args, { cwd = consumer, status = 0, offline = false, stream = "stdout" } = {}) {
  const env = { ...process.env, npm_config_audit: "false", npm_config_fund: "false" };
  if (offline) {
    env.npm_config_offline = "true";
    env.npm_config_registry = "http://127.0.0.1:1/";
  }
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
  if (result.error) throw result.error;
  assert.equal(result.status, status, args.join(" ") + "\n" + result.stdout + result.stderr);
  return stream === "both" ? { stdout: result.stdout, stderr: result.stderr } : result[stream];
}

function cli(args, status = 0, stream = "stdout") {
  // npm resolves the binary installed in this consumer, including the Windows .cmd shim.
  return run(process.execPath, [npm, "run", "--silent", "turntrace", "--", ...args], { status, offline: true, stream });
}

try {
  mkdirSync(consumer);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const archive = supplied ? resolve(supplied) : join(scratch, pkg.name + "-" + pkg.version + ".tgz");
  if (!supplied) {
    run(process.execPath, [npm, "pack", "--pack-destination", scratch], { cwd: root });
  }
  const entries = run("tar", ["-tzf", basename(archive)], { cwd: dirname(archive) }).trim().split(/\r?\n/);
  const required = new Set([
    "package/package.json", "package/README.md", "package/LICENSE",
    "package/THIRD_PARTY_NOTICES.md", "package/notices/zod-MIT.txt",
    "package/docs/architecture.md", "package/docs/distribution.md", "package/docs/adapter.md", "package/docs/acceptance.md",
    "package/examples/commit-first.buggy.json", "package/examples/recovery.idempotent.json",
    "package/dist/index.js", "package/dist/index.d.ts", "package/dist/cli/index.js",
    // Each lab example is explicitly reviewed and listed in the release manifest.
    ...pkg.files.filter(path => path.startsWith("examples/lab/")).map(path => "package/" + path),
  ]);
  for (const path of required) assert(entries.includes(path), "Missing tar entry " + path);
  for (const path of entries) {
    const allowed = required.has(path) || /^package\/dist\/(?:[\w-]+\/)*[\w-]+\.(?:js|d\.ts)$/.test(path);
    assert(allowed, "Unexpected tar entry " + path);
  }

  writeFileSync(join(consumer, "package.json"), JSON.stringify({
    name: "turntrace-pack-consumer", version: "1.0.0", private: true, scripts: { turntrace: "turntrace" },
  }));
  run(process.execPath, [npm, "install", "--omit=dev", archive]);
  const installed = join(consumer, "node_modules", "turntrace");
  const info = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.equal(info.version, pkg.version);
  assert.equal(info.private, true);
  assert.equal(info.license, "Apache-2.0");
  assert.equal(info.exports["."].types, "./dist/index.d.ts");
  for (const entry of entries.filter(name => name.endsWith(".md"))) {
    const document = join(installed, entry.slice("package/".length));
    const markdown = readFileSync(document, "utf8");
    for (const [, target] of markdown.matchAll(/\]\(([^\s)]+)\)/g)) {
      if (/^(?:https?:\/\/|mailto:|#)/i.test(target)) continue;
      const destination = resolve(dirname(document), decodeURIComponent(target.split("#")[0]));
      const inside = relative(installed, destination);
      assert(!isAbsolute(inside) && !inside.startsWith("..") && existsSync(destination),
        "Broken packaged documentation link in " + entry + ": " + target);
    }
  }

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
  const lab = join(examples, "lab");
  assert.match(cli(["replay", join(lab, "premature-ack.trace.json")], 1), /Verified replay/i);
  const sampled = cli(["explore", join(lab, "recovery.json"), "--seed", "73", "--samples", "3",
    "--max-runs", "3", "--profile", "--json", "--out-dir", "sampled histories"], 0, "both");
  const campaign = JSON.parse(sampled.stdout);
  const resources = JSON.parse(sampled.stderr);
  assert.equal(campaign.mode, "sampled");
  assert.equal(campaign.complete, false);
  assert.equal(campaign.histories, 3);
  assert.equal(campaign.artifacts.length, campaign.histories);
  assert.deepEqual(campaign, JSON.parse(readFileSync(join(consumer, "sampled histories", "index.json"), "utf8")));
  assert.deepEqual(resources.counts, campaign.counts);
  assert(resources.processPeakRssKiB > 0);
  const customer = join(lab, "customer-race.json");
  const adapter = join(lab, "customer-agent.mjs");
  // Explore both possible caller/timer orders in a third-party adapter, then replay
  // the saved witness using the adapter the consumer explicitly selected.
  const report = JSON.parse(cli(["explore", customer, "--adapter", adapter, "--max-runs", "200",
    "--out", "customer trace.json", "--json"], 1));
  assert(report.complete && report.violations > 0 && report.violations < report.histories);
  assert.match(cli(["replay", "customer trace.json", "--adapter", adapter], 1), /Verified replay/i);
  const failure = JSON.parse(cli(["run", join(lab, "reduce.json"), "--out", "full trace.json", "--json"], 1));
  const minimized = JSON.parse(cli(["minimize", "full trace.json", "--out", "reduced trace.json", "--json"], 1));
  assert.equal(minimized.originalDigest, failure.digest);
  assert(minimized.removedPerturbations.length > 0);
  assert.match(cli(["replay", "reduced trace.json"], 1), /Verified replay/i);
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
  assert.match(cli(["replay", "changed trace.json"], 2, "stderr"), /invalid|diverg|mismatch/i);
  console.log("Tar contents, production install, npm bin, ESM API, declarations and offline replays passed.");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
