import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { LabTrace } from "../src/lab/trace.js";

const cli = fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));
const scenario = {
  schemaVersion: 1, id: "dispatch", policy: "dispatch", delivery: "once", expectation: "observe",
  provider: { idempotent: false, query: false, amend: false },
  actions: ["A", "P", "U"].map(name => ({
    id: name, kind: "signal", name, tick: 1, parents: name === "P" ? ["A"] : [], data: {},
  })),
};
const moduleSource = `export default {
  id: "dispatch", version: "1",
  init() { return { updated: false }; },
  step(state, event) {
    if (event.kind !== "signal") return { next: state, commands: [] };
    if (event.data.assertBooking) return { next: state, commands: [
      { kind: "speech", generation: 1, claim: { bookingId: "unverified", day: "Tuesday" } }
    ] };
    if (event.name === "P") return { next: state, commands: [
      { kind: "observe", name: "route", data: { decision: state.updated ? "handoff" : "plan" } }
    ] };
    return { next: { updated: state.updated || event.name === "U" }, commands: [] };
  }
};`;

let workspace: string;
let input: string;
let entry: string;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "turntrace lab CLI "));
  input = join(workspace, "scenario.json");
  entry = join(workspace, "customer policy.mjs");
  await Promise.all([writeFile(input, JSON.stringify(scenario)), writeFile(entry, moduleSource)]);
});
afterAll(async () => { await rm(workspace, { recursive: true, force: true }); });

function invoke(...args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: workspace, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  return result;
}

function stdoutJson(expectedExit: number, ...args: string[]) {
  const result = invoke(...args);
  expect(result.status, result.stderr).toBe(expectedExit);
  return JSON.parse(result.stdout);
}

it("exports exactly three causal histories, replays their decisions and preserves existing artifacts", async () => {
  const output = join(workspace, "all histories");
  const args = ["explore", input, "--adapter", entry, "--json", "--out-dir", output];
  const report = stdoutJson(0, ...args);
  expect(report).toMatchObject({
    kind: "turntrace.campaign", schemaVersion: 1, mode: "exhaustive", complete: true,
    histories: 3, pendingPrefixes: 0, violations: 0,
    counts: { terminal: 3, blocked: 0, truncated: 0 },
  });
  const files = (await readdir(output)).sort();
  expect(files).toEqual(["history-00001.json", "history-00002.json", "history-00003.json", "index.json"]);
  const before = await Promise.all(files.map(name => readFile(join(output, name), "utf8")));
  expect(JSON.parse(before[3]!)).toEqual(report);
  const observed = [];
  for (const [index, name] of files.slice(0, 3).entries()) {
    const trace: LabTrace = JSON.parse(before[index]!);
    expect(report.manifest).toEqual(trace.manifest);
    expect(report.artifacts[index]).toEqual({ file: name, digest: trace.digest, status: "terminal" });
    const replay = stdoutJson(0, "replay", join(output, name), "--adapter", entry, "--json");
    expect(replay).toEqual(trace);
    expect(trace.manifest.adapter).toMatchObject({ kind: "local", id: "dispatch", runtime: process.version });
    const ordered = trace.events.filter(e => e.kind === "agent.signalDelivered").map(e => e.payload.name).join("");
    const decisions = trace.events.filter(e => e.kind === "agent.observed" && e.payload.name === "route");
    expect(decisions).toHaveLength(1);
    observed.push([ordered, decisions[0]!.payload.data]);
  }
  expect(report.witness).toEqual({ ...report.artifacts[0], firstFinding: null });
  expect(observed.sort(([left], [right]) => String(left).localeCompare(String(right)))).toEqual([
    ["APU", { decision: "plan" }], ["AUP", { decision: "handoff" }], ["UAP", { decision: "handoff" }],
  ]);
  const collision = invoke(...args);
  expect(collision.status).toBe(2);
  expect(JSON.parse(collision.stderr).error).toMatch(/exist/i);
  const existingFile = invoke("run", input, "--adapter", entry, "--json", "--out", join(output, files[0]!));
  expect(existingFile.status).toBe(2);
  expect(JSON.parse(existingFile.stderr).error).toMatch(/exists/i);
  expect((await readdir(output)).sort()).toEqual(files);
  expect(await Promise.all(files.map(name => readFile(join(output, name), "utf8")))).toEqual(before);
}, 20_000);

it("emits a parseable profile on stderr and reproduces the first seeded sample with run", async () => {
  const output = join(workspace, "samples");
  const sampled = invoke("explore", input, "--adapter", entry, "--seed", "21", "--samples", "2",
    "--profile", "--json", "--out-dir", output);
  expect(sampled.status, sampled.stderr).toBe(0);
  expect(JSON.parse(sampled.stdout)).toMatchObject({ mode: "sampled", complete: false, histories: 2, remainingSamples: 0 });
  const profile = JSON.parse(sampled.stderr);
  expect(profile).toMatchObject({ scenario: "dispatch", node: process.version, seed: 21, samples: 2, counts: { terminal: 2 } });
  for (const metric of ["elapsedMs", "cpuUserMs", "cpuSystemMs", "processPeakRssKiB"]) {
    expect(profile[metric]).toBeGreaterThanOrEqual(0);
  }
  const first = JSON.parse(await readFile(join(output, "history-00001.json"), "utf8"));
  expect(stdoutJson(0, "run", input, "--adapter", entry, "--seed", "21", "--json")).toEqual(first);
});

it("returns 3 for a cutoff and 1 when an observed safety violation precedes the cutoff", async () => {
  const partial = stdoutJson(3, "explore", input, "--adapter", entry, "--max-runs", "1", "--json");
  expect(partial).toMatchObject({ histories: 1, violations: 0, complete: false });
  expect(partial.pendingPrefixes).toBeGreaterThan(0);
  const empty = stdoutJson(3, "explore", input, "--adapter", entry, "--max-runs", "0", "--json");
  expect(empty).toMatchObject({
    histories: 0, witness: null, manifest: { engine: null, implementationSha256: null,
      scenarioSha256: partial.manifest.scenarioSha256, adapter: partial.manifest.adapter },
  });
  const truncation = stdoutJson(3, "run", input, "--adapter", entry, "--max-steps", "1", "--json");
  expect(truncation).toMatchObject({ status: "truncated", result: { verdict: "inconclusive", findings: [] } });
  const unsafe = join(workspace, "early-claim.json");
  await writeFile(unsafe, JSON.stringify({
    ...scenario, actions: scenario.actions.map(a => a.id === "A" ? { ...a, data: { assertBooking: true } } : a),
  }));
  const failure = stdoutJson(1, "explore", unsafe, "--adapter", entry, "--max-steps", "2", "--max-runs", "1", "--json");
  expect(failure).toMatchObject({
    counts: { truncated: 1 }, complete: false, violations: 1,
    witness: { status: "truncated", firstFinding: { property: "claim.supported" } },
  });
});

it("publishes the scenario, command and trace schemas and returns structured errors for invalid inputs", async () => {
  const spec = stdoutJson(0, "schema", "scenario");
  expect(spec.properties.expectation.enum).toContain("observe");
  expect(spec.properties.actions.items.oneOf).toContainEqual(expect.objectContaining({
    properties: expect.objectContaining({ kind: { type: "string", const: "signal" } }),
  }));
  const commands = stdoutJson(0, "schema", "command");
  expect(commands.oneOf).toContainEqual(expect.objectContaining({
    properties: expect.objectContaining({ kind: { type: "string", const: "observe" } }),
  }));
  expect(stdoutJson(0, "schema", "trace")).toMatchObject({
    properties: { schemaVersion: { const: 3 } }, required: expect.arrayContaining(["choices", "alternatives", "events", "digest"]),
  });
  expect(stdoutJson(0, "schema", "campaign")).toMatchObject({
    properties: { schemaVersion: { const: 1 }, kind: { const: "turntrace.campaign" } },
    required: expect.arrayContaining(["witness", "manifest", "histories"]),
  });
  const invalid = join(workspace, "unknown-parent.json");
  await writeFile(invalid, JSON.stringify({ ...scenario, actions: [{ ...scenario.actions[0], parents: ["missing"] }] }));
  const bad = invoke("run", invalid, "--adapter", entry, "--json");
  expect(bad.status).toBe(2);
  expect(bad.stdout).toBe("");
  expect(JSON.parse(bad.stderr).error).toMatch(/missing parent/i);
});
