import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { parseScenario, type Scenario } from "../src/lab/contract.js";
import { contrastLabTraces } from "../src/lab/contrast.js";
import { findOrderContrast } from "../src/lab/contrast-search.js";
import { exploreLab } from "../src/lab/engine.js";
import { replayLabTrace, runLabTrace, type LabAdapter, type LabTrace } from "../src/lab/trace.js";

// The native loader exercises the same trusted local module as the CLI.
const native = createRequire(import.meta.url)("../dist/lab/trace.js") as typeof import("../src/lab/trace.js");
const examples = new URL("../examples/lab/", import.meta.url);
const customer = JSON.parse(readFileSync(new URL("customer-race.json", examples), "utf8"));
const budget = { maxPairs: 64 };
const signal = (id: string, tick: number, parents: string[] = []) =>
  ({ id, tick, parents, kind: "signal", name: id, data: {} });

function inOrder(runs: LabTrace[], ids: string[]): LabTrace {
  const found = runs.find(trace => trace.choices.filter(id => ids.includes(id)).join(",") === ids.join(","));
  if (!found) throw new Error(`Missing test history for ${ids.join(" then ")}`);
  return found;
}

describe("counterfactual comparison of executable histories", () => {
  let scenario: Scenario;
  let adapter: LabAdapter;
  let histories: LabTrace[];
  let input: string;
  let timer: string;
  let left: LabTrace;
  let right: LabTrace;

  beforeAll(async () => {
    scenario = parseScenario({ ...customer, actions: [...customer.actions, signal("a", 10), signal("b", 10)] });
    adapter = await native.loadLabAdapter(scenario, fileURLToPath(new URL("customer-agent.mjs", examples)));
    const exploration = exploreLab(options => runLabTrace(scenario, adapter, options), { maxRuns: 64 });
    expect(exploration.complete).toBe(true);
    expect(exploration.runs).toHaveLength(24);
    histories = exploration.runs;
    const events = histories[0]!.events;
    input = events.find(event => event.kind === "input.delivered" && event.payload.inputId === "request-thursday")!.id;
    timer = events.find(event => event.kind === "timer.fired" && event.payload.timerId === "review-deadline")!.id;
    left = inOrder(histories, ["a", "b", input, timer]);
    right = inOrder(histories, ["b", "a", timer, input]);
  });

  it("isolates the delivery and timer after a shared prefix, even though the first choices differed only in noise", () => {
    const first = left.choices.findIndex((id, i) => id !== right.choices[i]);
    expect([left.choices[first], right.choices[first]]).toEqual(["a", "b"]);
    const { report, pair } = contrastLabTraces(left, right, adapter, budget);
    expect(report).toMatchObject({
      status: "isolated", firstDifference: { step: first + 1, leftId: "a", rightId: "b" },
      isolated: {
        actions: { leftFirst: { kind: "input.delivered", tick: 10 }, rightFirst: { kind: "timer.fired", tick: 10 } },
        left: { targetEvent: { kind: "claim.emitted" }, lastDelivery: { payload: { inputId: "request-thursday" } } },
        right: { counterpartEvent: { kind: "agent.reviewRequested", tick: 10 } },
      },
    });
    if (!pair || !report.isolated) throw new Error("The controlled witness pair is missing");
    const prefix = report.isolated.prefix;
    const pivot = prefix.length;
    for (const [arm, swap] of [[pair.left, [input, timer]], [pair.right, [timer, input]]] as const) {
      expect(arm.choices.slice(0, pivot)).toEqual(prefix);
      expect(arm.choices.slice(pivot, pivot + 2)).toEqual(swap);
      expect(arm.alternatives[pivot]).toEqual(expect.arrayContaining([input, timer]));
      expect(arm.alternatives[pivot + 1]).toContain(swap[1]);
      expect(arm.result.bookings).toEqual([{ bookingId: "booking-1", day: "Tuesday" }]);
      expect(arm.status).toBe("terminal");
      expect(replayLabTrace(JSON.parse(JSON.stringify(arm)), adapter)).toEqual(arm);
    }
    expect(pair.left.result.findings[0]).toMatchObject({
      property: "claim.supported", signature: left.result.findings[0]!.signature,
    });
    const claim = pair.left.events.find(event => event.id === pair.left.result.findings[0]!.eventId)!;
    expect(claim).toMatchObject({ actor: "agent", kind: "claim.emitted", tick: 10, payload: { claim: { day: "Thursday" } } });
    expect(pair.right.events.find(event => event.id === claim.id)).toMatchObject({
      actor: "agent", kind: "agent.reviewRequested", tick: 10,
    });
    expect(pair.left.result.played.map(entry => entry.day)).toEqual(["Thursday"]);
    expect(pair.right.result).toMatchObject({ verdict: "pass", findings: [], played: [] });
  });

  it("reports no contrast for a harmless reorder or a seed change with identical decisions", () => {
    const anotherPass = inOrder(histories, ["a", "b", timer, input]);
    expect(anotherPass.choices).not.toEqual(right.choices);
    expect(contrastLabTraces(anotherPass, right, adapter, budget).report.status).toBe("no-contrast");
    const seeded = runLabTrace(scenario, adapter, { prefix: left.choices, seed: 77 });
    expect(seeded.digest).not.toBe(left.digest);
    expect(seeded.choices).toEqual(left.choices);
    expect(contrastLabTraces(left, seeded, adapter, budget).report.status).toBe("no-contrast");
    // A different seed can also select a genuinely different schedule.
    expect(contrastLabTraces(seeded, right, adapter, budget).report.status).toBe("isolated");
  });

  it.each([0, 1])("keeps a search with a budget of %i candidate pairs inconclusive", maxPairs => {
    const { report, pair } = contrastLabTraces(left, right, adapter, { maxPairs });
    expect(report).toMatchObject({ status: "inconclusive", attempts: maxPairs });
    expect(pair).toBeUndefined();
  });

  it("declines schedule attribution for truncated histories, different limits, scenarios and policies", async () => {
    const partial = runLabTrace(scenario, adapter, { limits: { maxSteps: 2 } });
    expect(partial.status).toBe("truncated");
    const otherLimits = runLabTrace(scenario, adapter, { limits: { maxSteps: 200 }, prefix: right.choices });
    expect(otherLimits.status).toBe("terminal");
    const changed = runLabTrace({ ...scenario, actions: customer.actions }, adapter);
    const newPolicy = { ...scenario, policy: "safe" };
    const fixed = runLabTrace(newPolicy, await native.loadLabAdapter(newPolicy));
    for (const [a, b] of [[partial, partial], [left, otherLimits], [left, changed], [left, fixed]]) {
      const result = contrastLabTraces(a!, b!, adapter, budget);
      expect(result.report.status).toBe("inconclusive");
      expect(result.pair).toBeUndefined();
    }
  });
});

it("rejects an initially enabled swap when playback of the first copy blocks immediate delivery of the second", async () => {
  const scenario = parseScenario({
    ...customer, policy: "safe", expectation: "confirmed",
    actions: [
      { id: "duplicate", kind: "duplicate-next", channel: "playback", tick: 0 },
      { id: "request", kind: "input", inputId: "original", day: "Thursday", tick: 0, parents: ["duplicate"] },
    ],
  });
  const adapter = await native.loadLabAdapter(scenario);
  const reference = runLabTrace(scenario, adapter);
  const pivot = reference.alternatives.findIndex(ids => ids.length === 2 && ids.every(id => id.startsWith("@playback.")));
  expect(pivot).toBeGreaterThan(0);
  const [a, b] = reference.alternatives[pivot]!;
  const before = reference.choices.slice(0, pivot);
  const left = runLabTrace(scenario, adapter, { prefix: [...before, a!] });
  const right = runLabTrace(scenario, adapter, { prefix: [...before, b!] });
  expect(left.alternatives[pivot + 1]).not.toContain(b);
  expect(right.alternatives[pivot + 1]).not.toContain(a);
  const sameStarts = (l: LabTrace, r: LabTrace) =>
    l.result.played[0]?.eventId === left.result.played[0]?.eventId &&
    r.result.played[0]?.eventId === right.result.played[0]?.eventId;
  expect(left.result.played[0]!.eventId).not.toBe(right.result.played[0]!.eventId);
  const search = findOrderContrast(left, right, adapter, sameStarts, 64);
  expect(search.attempts).toBeGreaterThan(0);
  expect(search.nonReversiblePairs).toBeGreaterThan(0);
  expect(search.nonterminalPairs).toBe(0);
  expect(search.status).toBe("not-isolated");
  expect(search.pair).toBeUndefined();
});

it("counts a step-limited counterfactual when both original schedules finish", async () => {
  const directory = await mkdtemp(join(tmpdir(), "turntrace bounded swap "));
  try {
    const path = join(directory, "timer.mjs");
    await writeFile(path, `export default {
      id: "timer", version: "1", init() { return ""; },
      step(state, event) {
        const next = event.kind === "signal" ? state + event.name : state;
        const commands = next === "AB" && event.kind === "signal"
          ? [{ kind: "timer", timerId: "extra-step", delayTicks: 1 }] : [];
        return { next, commands };
      }
    };`);
    const scenario = parseScenario({ ...customer, policy: "timer", expectation: "observe",
      actions: ["A", "B", "C"].map(id => signal(id, 1)) });
    const adapter = await native.loadLabAdapter(scenario, path);
    const lane = (...order: string[]) => runLabTrace(scenario, adapter, { prefix: ["@boot", ...order], limits: { maxSteps: 4 } });
    const left = lane("A", "C", "B");
    const right = lane("B", "C", "A");
    expect([left.status, right.status]).toEqual(["terminal", "terminal"]);
    expect(lane("A", "B", "C")).toMatchObject({ status: "truncated", reason: "maxSteps exhausted" });
    expect(findOrderContrast(left, right, adapter, () => true, 1)).toEqual({
      attempts: 1, status: "exhausted", nonReversiblePairs: 0, nonterminalPairs: 1,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("isolates a changed named observation at P#3 in passing histories and rejects ambiguous occurrences", async () => {
  const directory = await mkdtemp(join(tmpdir(), "turntrace contrast "));
  const path = join(directory, "approval.mjs");
  try {
    await writeFile(path, `export default {
      id: "approval", version: "1", init() { return { approved: false, available: true }; },
      step(state, event) {
        if (event.kind === "signal") {
          if (event.name === "A") return { next: { ...state, approved: true }, commands: [] };
          if (event.name === "U") return { next: { ...state, available: false }, commands: [] };
          const plan = state.approved && state.available;
          return { next: state, commands: [{ kind: "observe", name: "preview",
            data: { decision: plan ? "plan" : "handoff", plans: plan ? ["POST"] : [] } }] };
        }
        return { next: state, commands: [] };
      }
    };`);
    const scenario = parseScenario({ ...customer, policy: "approval", expectation: "observe",
      actions: [signal("A", 0), signal("P", 1, ["A"]), signal("U", 1, ["A"])] });
    const adapter = await native.loadLabAdapter(scenario, path);
    const lane = (s: Scenario, order: string[]) => runLabTrace(s, adapter, { preferredChoices: order });
    const left = lane(scenario, ["A", "P", "U"]);
    const right = lane(scenario, ["A", "U", "P"]);
    expect(left.result.verdict).toBe("pass");
    expect(right.result.verdict).toBe("pass");
    expect(contrastLabTraces(left, right, adapter, budget).report.status).toBe("no-contrast");
    const { report, pair } = contrastLabTraces(left, right, adapter, { observation: "preview", maxPairs: 8 });
    expect(report.status).toBe("isolated");
    if (!pair) throw new Error("The observed decision has no executable witnesses");
    for (const [arm, data] of [[pair.left, { decision: "plan", plans: ["POST"] }],
      [pair.right, { decision: "handoff", plans: [] }]] as const) {
      expect(arm.result.verdict).toBe("pass");
      expect(arm.events.find(event => event.id === "P#3")).toMatchObject({
        kind: "agent.observed", payload: { epoch: 1, name: "preview", data },
      });
      expect(replayLabTrace(arm, adapter)).toEqual(arm);
    }
    expect(contrastLabTraces(left, right, adapter, { ...budget, observation: "absent" }).report.status).toBe("inconclusive");
    const repeated = parseScenario({ ...scenario, actions: [...scenario.actions, signal("again", 2, ["P", "U"])] });
    const ambiguous = contrastLabTraces(lane(repeated, ["P", "U"]), lane(repeated, ["U", "P"]), adapter, { ...budget, observation: "preview" });
    expect(ambiguous.report.status).toBe("inconclusive");
    expect(ambiguous.pair).toBeUndefined();

    const epochs = parseScenario({ ...scenario, actions: [
      signal("P", 1), { id: "crash", kind: "crash", tick: 1 }, { id: "restart", kind: "restart", tick: 1, parents: ["crash"] },
    ] });
    const oldInstance = lane(epochs, ["P", "crash", "restart"]);
    const newInstance = lane(epochs, ["crash", "restart", "P"]);
    const epochsAtSlot = [oldInstance, newInstance].map(t => t.events.find(e => e.id === "P#3")?.payload.epoch);
    expect(epochsAtSlot).toEqual([1, 2]);
    expect(contrastLabTraces(oldInstance, newInstance, adapter, { ...budget, observation: "preview" }).report.status)
      .toBe("inconclusive");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
