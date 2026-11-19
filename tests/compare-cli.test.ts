import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { CampaignReport } from "../src/cli/campaign.js";
import type { ContrastReport } from "../src/lab/contrast.js";
import type { LabTrace } from "../src/lab/trace.js";
import { canonicalJson } from "../src/trace.js";

const cli = process.env.TURNTRACE_TEST_CLI ?? fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));
const examples = resolve(dirname(cli), "../../examples");
const scenario = join(examples, "lab", "customer-race.json");
let workspace: string;
let adapter: string;
let replica: string;
let failing: string;
let passing: string;

function invoke(expectedExit: number, ...args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: workspace, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  expect(result.status, result.stderr || result.stdout).toBe(expectedExit);
  return result;
}

function json<T>(exit: number, ...args: string[]): T {
  const result = invoke(exit, ...args, "--json");
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8"));
}

async function rejected(directory: string, error: RegExp, ...args: string[]) {
  const result = invoke(2, "compare", ...args, "--out-dir", directory, "--json");
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr).error).toMatch(error);
  await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
}

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "turntrace compare "));
  adapter = join(workspace, "customer-agent.mjs");
  replica = join(workspace, "second checkout", "customer-agent.mjs");
  await mkdir(dirname(replica));
  await Promise.all([adapter, replica].map(path => copyFile(join(examples, "lab", "customer-agent.mjs"), path)));
  const histories = join(workspace, "customer histories");
  const campaign = json<CampaignReport>(1, "explore", scenario, "--adapter", adapter, "--max-runs", "8", "--out-dir", histories);
  expect(campaign).toMatchObject({ complete: true, histories: 2, violations: 1 });
  const failure = campaign.artifacts?.find(a => a.firstProperty === "claim.supported");
  const control = campaign.artifacts?.find(a => a.status === "terminal" && !a.firstProperty);
  if (!failure || !control) throw new Error("The published customer scenario must yield a failure and a passing control.");
  failing = join(histories, failure.file);
  passing = join(histories, control.file);
}, 20_000);

afterAll(async () => { await rm(workspace, { recursive: true, force: true }); });

it.each([false, true])("isolates the customer race and exports replayable, oriented witnesses (reversed=%s)", async reverse => {
  const directory = join(workspace, reverse ? "pass then fail" : "fail then pass");
  const args = reverse
    ? [passing, failing, "--left-adapter", replica, "--right-adapter", adapter]
    : [failing, passing, "--adapter", adapter];
  const report = json<ContrastReport>(0, "compare", ...args, "--out-dir", directory);
  expect(report.status).toBe("isolated");
  expect(report.firstDifference).toMatchObject({ left: { tick: 10 }, right: { tick: 10 } });
  const files = ["comparison.json", "left.json", "right.json"];
  expect((await readdir(directory)).sort()).toEqual(files);
  expect(await readJson(join(directory, "comparison.json"))).toEqual(report);
  for (const side of ["left", "right"] as const) {
    const failed = reverse ? side === "right" : side === "left";
    const trace = json<LabTrace>(failed ? 1 : 0, "replay", join(directory, side + ".json"), "--adapter", adapter);
    const expectedVerdict = failed ? "fail" : "pass";
    expect(trace.result.verdict).toBe(expectedVerdict);
    expect(trace.result.findings[0]?.property).toBe(failed ? "claim.supported" : undefined);
    expect(report.inputs[side].verdict).toBe(expectedVerdict);
    expect(report.isolated?.[side].summary.digest).toBe(trace.digest);
  }
}, 20_000);

it("preserves every byte in an existing witness directory", async () => {
  const directory = join(workspace, "occupied");
  await mkdir(directory);
  const names = ["comparison.json", "left.json", "right.json", "other.txt"];
  await Promise.all(names.map(name => writeFile(join(directory, name), "original " + name)));
  const result = invoke(2, "compare", failing, passing, "--adapter", adapter, "--out-dir", directory, "--json");
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr).error).toMatch(/exist/i);
  expect((await readdir(directory)).sort()).toEqual([...names].sort());
  for (const name of names) expect(await readFile(join(directory, name), "utf8")).toBe("original " + name);
});

it.each([
  { name: "matching verdicts", exit: 0, status: "no-contrast", flags: [], same: true },
  { name: "exhausted pair budget", exit: 3, status: "inconclusive", flags: ["--max-pairs", "0"], same: false },
  { name: "missing observation", exit: 3, status: "inconclusive", flags: ["--observation", "never-emitted"], same: false },
])("writes only the report for $name", async ({ name, exit, status, flags, same }) => {
  const directory = join(workspace, name);
  const report = json<ContrastReport>(exit, "compare", failing, same ? failing : passing, "--adapter", adapter, ...flags, "--out-dir", directory);
  expect(report).toMatchObject({ status, isolated: null, attempts: 0 });
  expect(await readdir(directory)).toEqual(["comparison.json"]);
  expect(await readJson(join(directory, "comparison.json"))).toEqual(report);
});

it("reports incompatible scheduler limits after both terminal inputs verify", async () => {
  const differentLimits = join(workspace, "different limits.json");
  const run = json<LabTrace>(1, "run", scenario, "--adapter", adapter, "--max-steps", "50", "--out", differentLimits);
  expect(run.status).toBe("terminal");
  const directory = join(workspace, "limit comparison");
  const report = json<ContrastReport>(3, "compare", passing, differentLimits, "--adapter", adapter, "--out-dir", directory);
  expect(report).toMatchObject({ status: "inconclusive", isolated: null, attempts: 0 });
  expect(report.reason).toMatch(/limits/i);
  expect(await readdir(directory)).toEqual(["comparison.json"]);
  expect(await readJson(join(directory, "comparison.json"))).toEqual(report);
});

it("reports an inconclusive comparison for a verified prefix that hit its own step limit", async () => {
  const prefix = join(workspace, "prefix.json");
  expect(json<LabTrace>(3, "run", scenario, "--adapter", adapter, "--max-steps", "1", "--out", prefix).status).toBe("truncated");
  const directory = join(workspace, "truncated");
  const report = json<ContrastReport>(3, "compare", prefix, prefix, "--adapter", adapter, "--out-dir", directory);
  expect(report).toMatchObject({ status: "inconclusive", isolated: null, attempts: 0 });
  expect(report.inputs.left.status).toBe("truncated");
  expect(await readdir(directory)).toEqual(["comparison.json"]);
});

it("replays the second input and rejects edited evidence even with a matching digest", async () => {
  const forgedPath = join(workspace, "edited.json");
  const { digest, ...edited } = await readJson<LabTrace>(passing);
  const receipt = edited.events.find(e => e.kind === "transport.dropped");
  if (!receipt) throw new Error("Expected the customer trace to contain a dropped receipt.");
  receipt.payload.channel = "input";
  const replacement = createHash("sha256").update(canonicalJson(edited)).digest("hex");
  expect(replacement).not.toBe(digest);
  await writeFile(forgedPath, JSON.stringify({ ...edited, digest: replacement }));
  await rejected(join(workspace, "edited report"), /right input[\s\S]*diverged at event/i, failing, forgedPath, "--adapter", adapter);
});

it("requires an authentic, explicitly selected adapter on each side", async () => {
  const changed = join(workspace, "changed.mjs");
  await writeFile(changed, (await readFile(adapter, "utf8")) + "\n// independent customer revision\n");
  const changedTrace = join(workspace, "changed.json");
  json(1, "run", scenario, "--adapter", changed, "--out", changedTrace);
  const report = json<ContrastReport>(3, "compare", failing, changedTrace, "--left-adapter", adapter, "--right-adapter", changed);
  expect(report.status).toBe("inconclusive");
  expect(report.reason).toMatch(/adapter/i);
  await rejected(join(workspace, "wrong module"), /right input[\s\S]*incompatible/i, failing, changedTrace, "--adapter", adapter);
  await rejected(join(workspace, "missing module"), /right input[\s\S]*adapter/i, failing, passing, "--left-adapter", adapter);
  await rejected(join(workspace, "missing input"), /right input[\s\S]*ENOENT/i, failing, join(workspace, "absent.json"), "--adapter", adapter);
}, 20_000);

it.each([
  { file: "commit-first.buggy.json", version: 1, exit: 1 },
  { file: "recovery.idempotent.json", version: 2, exit: 0 },
])("keeps V$version replayable and rejects it as a comparison input", async ({ file, version, exit }) => {
  const demo = join(examples, file);
  expect(json(exit, "replay", demo)).toMatchObject({ schemaVersion: version });
  await rejected(join(workspace, "legacy " + version), /right input[\s\S]*schema 3/i, failing, demo, "--left-adapter", adapter);
});

it("rejects an unknown trace version before publishing the diagnosis", async () => {
  const futurePath = join(workspace, "future.json");
  const original = await readJson<LabTrace>(passing);
  await writeFile(futurePath, JSON.stringify({ ...original, schemaVersion: 99 }));
  await rejected(join(workspace, "future report"), /right input[\s\S]*schema 3/i, failing, futurePath, "--adapter", adapter);
});

it.each([
  { flags: ["--max-pairs", "-1"], message: /max-pairs/i },
  { flags: ["--max-pairs", "1.5"], message: /max-pairs/i },
  { flags: ["--observation", "  "], message: /observation/i },
  { flags: ["--adapter", "   "], message: /adapter.*path/i },
  { flags: ["--adapter", "one.mjs", "--right-adapter", "two.mjs"], message: /adapter/i },
])("rejects invalid comparison arguments $flags", async ({ flags, message }) => {
  const directory = join(workspace, "invalid flags");
  await rejected(directory, message, failing, passing, ...flags);
});
