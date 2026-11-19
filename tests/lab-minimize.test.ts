import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseScenario, type ScenarioAction } from "../src/lab/contract.js";
import { minimizeLabTrace } from "../src/lab/minimize.js";
import { loadLabAdapter, replayLabTrace, runLabTrace } from "../src/lab/trace.js";

const fixture = parseScenario(JSON.parse(readFileSync(new URL("../examples/lab/reduce.json", import.meta.url), "utf8")));
const input: ScenarioAction = {
  id: "first", kind: "input", tick: 0, parents: [], inputId: "asked-tuesday", day: "Tuesday",
};

describe("causal reduction of a recorded lab failure", () => {
  it("removes a group and its transitive dependent in one attempt and preserves the original evidence", async () => {
    const adapter = await loadLabAdapter(fixture);
    const original = runLabTrace(fixture, adapter, { seed: 41 });
    const archived = JSON.stringify(original);
    const result = minimizeLabTrace(original, adapter, { maxAttempts: 1 });
    expect(result.status).toBe("irreducible");
    expect(result.attempts).toBe(1);
    expect(result.removedPerturbations).toEqual(["spare.delay", "spare.drop", "spare.input"]);
    expect(result.reduced.options.seed).toBe(41);
    expect(result.reduced.events.length).toBeLessThan(original.events.length);
    expect(result.reduced.result.findings[0]).toMatchObject(result.target);
    expect(replayLabTrace(JSON.parse(JSON.stringify(result.reduced)), adapter)).toEqual(result.reduced);
    expect(JSON.stringify(result.original)).toBe(archived);
    expect(JSON.stringify(original)).toBe(archived);
  });

  it("retains an optional ancestor needed by a required action", async () => {
    const anchor: ScenarioAction = {
      id: "anchor", kind: "delay-next", channel: "speech", delayTicks: 0, tick: 0, parents: [], optional: true,
    };
    const scenario = { ...fixture, actions: [anchor, { ...input, tick: 1, parents: ["anchor"] }] };
    const adapter = await loadLabAdapter(scenario);
    const trace = runLabTrace(scenario, adapter);
    const result = minimizeLabTrace(trace, adapter, { maxAttempts: 0 });
    expect(result).toMatchObject({ status: "irreducible", attempts: 0, removedPerturbations: [] });
    expect(result.reduced).toEqual(trace);
  });

  it("keeps the input that failed even when another input violates the same property", async () => {
    const first = { ...input, optional: true };
    const second: ScenarioAction = {
      id: "second", kind: "input", tick: 50, parents: [], inputId: "asked-thursday", day: "Thursday", optional: true,
    };
    const scenario = { ...fixture, actions: [first, second] };
    const adapter = await loadLabAdapter(scenario);
    const original = runLabTrace(scenario, adapter);
    const different = runLabTrace({ ...scenario, actions: [second] }, adapter);
    expect(original.result.findings[0]!.property).toBe(different.result.findings[0]!.property);
    expect(original.result.findings[0]!.signature).not.toBe(different.result.findings[0]!.signature);
    const result = minimizeLabTrace(original, adapter);
    expect(result.status).toBe("irreducible");
    expect(result.removedPerturbations).toEqual(["second"]);
    expect(result.reduced.result.findings[0]).toMatchObject(result.target);
  });

  it("keeps the same unsupported external booking when two separate inputs request Thursday", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turntrace same-day claims "));
    const path = join(directory, "agent.mjs");
    try {
      await writeFile(path, `export default {
        id: "same-day", version: "1", init() { return {}; },
        step(next, input) {
          const commands = input.kind === "input"
            ? [{ kind: "speech", generation: 1, claim: { bookingId: "candidate-" + input.inputId, day: input.day } }]
            : [];
          return { next, commands };
        }
      };`);
      const scenario = parseScenario({ ...fixture, policy: "same-day", actions: [
        { id: "first", kind: "input", tick: 0, inputId: "one", day: "Thursday", optional: true },
        { id: "second", kind: "input", tick: 20, inputId: "two", day: "Thursday" },
      ] });
      const native = createRequire(import.meta.url)("../dist/lab/trace.js") as typeof import("../src/lab/trace.js");
      const adapter = await native.loadLabAdapter(scenario, path);
      const original = runLabTrace(scenario, adapter);
      const other = runLabTrace({ ...scenario, actions: scenario.actions.slice(1) }, adapter);
      expect(original.result.findings[0]?.property).toBe("claim.supported");
      expect(other.result.findings[0]?.property).toBe("claim.supported");
      expect(original.result.findings[0]?.signature).not.toBe(other.result.findings[0]?.signature);
      const result = minimizeLabTrace(original, adapter);
      expect(result).toMatchObject({ status: "irreducible", attempts: 1, removedPerturbations: [] });
      const issued = result.reduced.events.find(event => event.kind === "claim.emitted");
      expect(issued?.payload).toMatchObject({ claim: { bookingId: "candidate-one", day: "Thursday" } });
      expect(result.reduced.result.findings[0]).toMatchObject({ ...result.target, eventId: issued?.id });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports a spent reduction budget separately from a proven local minimum", async () => {
    const adapter = await loadLabAdapter(fixture);
    const original = runLabTrace(fixture, adapter);
    const result = minimizeLabTrace(original, adapter, { maxAttempts: 0 });
    expect(result).toMatchObject({
      status: "exhausted", exhaustedBy: "attempts", attempts: 0, maxAttempts: 0,
      maxMilliseconds: null, elapsedMilliseconds: null, removedPerturbations: [],
    });
    expect(result.reduced).toEqual(original);
    expect(() => minimizeLabTrace(original, adapter, { maxAttempts: -1 })).toThrow(/maxAttempts/);
    const timed = minimizeLabTrace(original, adapter, { maxMilliseconds: 0 });
    expect(timed).toMatchObject({ status: "exhausted", exhaustedBy: "time", maxMilliseconds: 0, attempts: 0 });
    expect(timed.elapsedMilliseconds).toBeGreaterThanOrEqual(0);
    expect(timed.reduced).toEqual(original);
  });

  it("reduces an observed prefix safety violation even when the run cannot finish", async () => {
    const adapter = await loadLabAdapter(fixture);
    const original = runLabTrace(fixture, adapter, { limits: { maxSteps: 8 } });
    expect(original.status).toBe("truncated");
    expect(original.result.findings[0]?.property).toBe("input.durable-ack");
    const result = minimizeLabTrace(original, adapter);
    expect(result).toMatchObject({ status: "irreducible", attempts: 1, inconclusiveAttempts: 0 });
    expect(result.removedPerturbations).toHaveLength(3);
    expect(result.reduced.status).toBe("truncated");
    expect(replayLabTrace(result.reduced, adapter).result.findings[0]).toMatchObject(result.target);
  });

  it("reports a truncated candidate without evidence of the target and avoids claiming irreducibility", async () => {
    // Losing the write receipt prevents later booking and playback actions.
    // Removing that loss leaves more work than the recorded step limit permits.
    const drop: ScenarioAction = {
      id: "drop.store-ack", kind: "drop-next", channel: "storeAck", tick: 0, parents: [], optional: true,
    };
    const scenario = { ...fixture, policy: "safe", expectation: "review" as const, actions: [drop, { ...input, tick: 1 }] };
    const adapter = await loadLabAdapter(scenario);
    const unlimited = runLabTrace(scenario, adapter);
    const limits = { maxSteps: unlimited.choices.length };
    const original = runLabTrace(scenario, adapter, { limits });
    expect(original.status).toBe("terminal");
    const withoutDrop = runLabTrace({ ...scenario, actions: scenario.actions.slice(1) }, adapter, { limits });
    expect(withoutDrop.status).toBe("truncated");
    expect(withoutDrop.result.findings).toEqual([]);
    const result = minimizeLabTrace(original, adapter);
    expect(result).toMatchObject({ status: "inconclusive", attempts: 1, inconclusiveAttempts: 1, removedPerturbations: [] });
    expect(result.reduced).toEqual(original);
  });

  it("refuses an edited source and a verified passing run", async () => {
    const adapter = await loadLabAdapter(fixture);
    const original = runLabTrace(fixture, adapter);
    expect(() => minimizeLabTrace({ ...original, digest: "0".repeat(64) }, adapter)).toThrow();
    const safe = { ...fixture, policy: "safe" };
    const safeAdapter = await loadLabAdapter(safe);
    const passing = runLabTrace(safe, safeAdapter);
    expect(passing.result.findings).toEqual([]);
    expect(() => minimizeLabTrace(passing, safeAdapter)).toThrow(/violation/i);
  });
});
