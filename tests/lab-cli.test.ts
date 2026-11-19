import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { LabEvent } from "../src/lab/contract.js";
import type { LabTrace } from "../src/lab/trace.js";

const cli = process.env.TURNTRACE_TEST_CLI ?? fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));
const requestId = "dispatch-42";
const scenario = {
  schemaVersion: 1, id: "dispatch", policy: "dispatch", delivery: "once", expectation: "observe",
  provider: { idempotent: false, query: false, amend: false },
  actions: ["A", "P", "U"].map(name => ({
    id: name, kind: "signal", name, tick: 1, parents: name === "P" ? ["A"] : [],
    data: name === "U" ? { requestId, status: "uncertain" } : { requestId },
  })),
};
function moduleSource(handoffCondition = 'state[requestId] === "uncertain"', preparePlan = 'decision === "plan"') {
  return `export default {
  id: "dispatch", version: "1",
  init() { return {}; },
  step(state, event) {
    if (event.kind !== "signal") return { next: state, commands: [] };
    if (event.data.assertBooking) return { next: state, commands: [
      { kind: "speech", generation: 1, claim: { bookingId: "unverified", day: "Tuesday" } }
    ] };
    const { requestId, status } = event.data;
    if (event.name === "U") return { next: { ...state, [requestId]: status }, commands: [] };
    if (event.name === "P") {
      const decision = ${handoffCondition} ? "handoff" : "plan";
      const plans = ${preparePlan} ? [{ method: "POST" }] : [];
      return { next: state, commands: [{ kind: "observe", name: "route", data: { requestId, decision, plans } }] };
    }
    return { next: state, commands: [] };
  }
};`;
}

let workspace: string;
let input: string;
let entry: string;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "turntrace lab CLI "));
  input = join(workspace, "scenario.json");
  entry = join(workspace, "customer policy.mjs");
  await Promise.all([writeFile(input, JSON.stringify(scenario)), writeFile(entry, moduleSource())]);
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

function data(event: LabEvent) {
  const value = event.payload.data;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a structured payload.");
  return value;
}

// Consumer contract, evaluated from public deliveries and diagnostics only.
function inspectRoute(events: readonly LabEvent[]) {
  const signals = events.filter(e => e.actor === "agent" && e.kind === "agent.signalDelivered");
  const decisions = events.filter(e => e.actor === "agent" && e.kind === "agent.observed" && e.payload.name === "route");
  if (decisions.length !== 1) throw new Error("Expected one routing decision.");
  const observation = decisions[0]!;
  const route = data(observation);
  if (typeof route.requestId !== "string" || typeof observation.payload.epoch !== "number") {
    throw new Error("A routing decision must identify its request and epoch.");
  }
  const matching = signals.filter(e => e.payload.epoch === observation.payload.epoch && data(e).requestId === route.requestId);
  const preparation = matching.find(e => e.payload.name === "P" && observation.parents.includes(e.id));
  if (!preparation || events.indexOf(preparation) >= events.indexOf(observation)) {
    throw new Error("The routing decision must be caused by a delivered preparation for the same request and epoch.");
  }
  const updates = matching.slice(0, matching.indexOf(preparation)).filter(e => e.payload.name === "U");
  const latest = updates.at(-1);
  const expected = latest && data(latest).status === "uncertain" ? "handoff" : "plan";
  if (route.decision !== expected) {
    throw new Error(`Expected ${expected} from the latest delivered availability for ${route.requestId}; observed ${route.decision}.`);
  }
  if (!Array.isArray(route.plans)) throw new Error("The routing diagnostic must include its plans.");
  const methods = route.plans.map(plan => plan && typeof plan === "object" && !Array.isArray(plan) ? plan.method : null);
  if (expected === "handoff" && methods.length !== 0) throw new Error("Handoff must leave zero plans.");
  if (expected === "plan" && (methods.length !== 1 || methods[0] !== "POST")) {
    throw new Error("Preparation must produce exactly one POST plan.");
  }
  return { signals: signals.map(e => e.payload.name).join(""), decision: route.decision, methods };
}

it("consumer oracle accepts one plan and two handoffs across exactly three replayable histories", async () => {
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
    observed.push(inspectRoute(replay.events));
  }
  expect(report.witness).toEqual({ ...report.artifacts[0], firstFinding: null });
  expect(observed.sort((left, right) => left.signals.localeCompare(right.signals))).toEqual([
    { signals: "APU", decision: "plan", methods: ["POST"] },
    { signals: "AUP", decision: "handoff", methods: [] },
    { signals: "UAP", decision: "handoff", methods: [] },
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

it("consumer oracle rejects an anticipatory handoff before uncertain availability is delivered", async () => {
  const premature = join(workspace, "premature.mjs");
  await writeFile(premature, moduleSource("true"));
  const trace: LabTrace = stdoutJson(0, "run", input, "--adapter", premature, "--json");
  expect(trace.result).toMatchObject({ verdict: "pass", findings: [] });
  expect(trace.events.filter(e => e.kind === "agent.signalDelivered").map(e => e.payload.name)).toEqual(["A", "P", "U"]);
  expect(() => inspectRoute(trace.events)).toThrow(/Expected plan.*observed handoff/);
});

function update(id: string, tick: number, status: string, target = requestId) {
  return { id, tick, kind: "signal", name: "U", data: { requestId: target, status } };
}

it.each([
  { witness: "superseded status", updates: [update("first", 0, "uncertain"), update("newer", 1, "available")],
    mutantRule: "state[requestId] !== undefined" },
  { witness: "different request", updates: [update("other", 0, "uncertain", "dispatch-99")],
    mutantRule: 'Object.values(state).includes("uncertain")' },
  { witness: "previous epoch", updates: [update("old", 0, "uncertain"),
    { id: "crash", kind: "crash", tick: 1 }, { id: "restart", kind: "restart", tick: 2 }],
    mutantRule: "true" },
])("consumer oracle rejects stale uncertainty from a $witness", async ({ witness, updates, mutantRule }) => {
  const stale = join(workspace, witness + ".mjs");
  const path = join(workspace, witness + ".json");
  const actions = [
    ...updates,
    { id: "A", kind: "signal", name: "A", tick: 3, data: { requestId } },
    { id: "P", kind: "signal", name: "P", tick: 4, parents: ["A"], data: { requestId } },
  ];
  await Promise.all([writeFile(stale, moduleSource(mutantRule)), writeFile(path, JSON.stringify({ ...scenario, actions }))]);
  const control: LabTrace = stdoutJson(0, "run", path, "--adapter", entry, "--json");
  expect(inspectRoute(control.events).decision).toBe("plan");
  const mutant: LabTrace = stdoutJson(0, "run", path, "--adapter", stale, "--json");
  expect(mutant.result).toMatchObject({ verdict: "pass", findings: [] });
  expect(() => inspectRoute(mutant.events)).toThrow(/Expected plan.*observed handoff/);
});

it("consumer oracle rejects a handoff that also exposes a POST plan", async () => {
  const ghost = join(workspace, "ghost.mjs");
  const path = join(workspace, "uncertainty-before-preparation.json");
  const actions = scenario.actions.map(a => a.id === "P" ? { ...a, parents: ["A", "U"] } : a);
  await Promise.all([writeFile(ghost, moduleSource(undefined, "true")), writeFile(path, JSON.stringify({ ...scenario, actions }))]);
  const trace: LabTrace = stdoutJson(0, "run", path, "--adapter", ghost, "--json");
  expect(trace.result).toMatchObject({ verdict: "pass", findings: [] });
  expect(() => inspectRoute(trace.events)).toThrow(/Handoff must leave zero plans/);
});

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
