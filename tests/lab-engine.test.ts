import { describe, expect, it, vi } from "vitest";
import { exploreLab, LabScheduler, type LabAction, type LabRunOptions } from "../src/lab/engine.js";

const action = (id: string, tick = 0, parents: string[] = []): LabAction => ({ id, tick, parents, run() {} });

function forest(options: LabRunOptions = {}) {
  const scheduler = new LabScheduler();
  const observed: string[] = [];
  for (const item of [action("C"), action("B", 0, ["A"]), action("A")]) {
    scheduler.schedule({ ...item, run: () => observed.push(item.id) });
  }
  return { ...scheduler.run(options), observed };
}

describe("bounded interleaving exploration", () => {
  it("runs fresh worlds in DFS order for the three topological orders of A→B plus independent C", () => {
    const result = exploreLab(forest, { maxRuns: 3 });
    expect(result.complete).toBe(true);
    expect(result.pendingPrefixes).toBe(0);
    expect(result.mode).toBe("exhaustive");
    expect(result.counts).toEqual({ terminal: 3, blocked: 0, truncated: 0 });
    expect(result.runs.map((run) => run.choices.join(""))).toEqual(["ABC", "ACB", "CAB"]);
    for (const run of result.runs) {
      expect(run.observed).toEqual(run.choices);
      expect(forest({ replayChoices: run.choices })).toEqual(run);
    }
    expect(result.runs[0]!.alternatives).toEqual([["A", "C"], ["B", "C"], ["C"]]);
  });

  it("matches a permutation oracle for all 64 forward-edge DAGs of four nodes", () => {
    const nodes = ["A", "B", "C", "D"];
    const permutations: string[][] = [];
    for (const a of nodes) for (const b of nodes) for (const c of nodes) for (const d of nodes) {
      const order = [a, b, c, d];
      if (new Set(order).size === 4) permutations.push(order);
    }
    const possibleEdges = nodes.flatMap((from, i) => nodes.slice(i + 1).map((to) => ({ from, to })));
    for (let mask = 0; mask < 2 ** possibleEdges.length; mask++) {
      const edges = possibleEdges.filter((_, index) => mask & (1 << index));
      const expected = permutations.filter((order) => edges.every(({ from, to }) => order.indexOf(from) < order.indexOf(to)));
      const actual = exploreLab((options) => {
        const scheduler = new LabScheduler();
        for (const id of nodes) scheduler.schedule(action(id, 0, edges.filter(({ to }) => to === id).map(({ from }) => from)));
        return scheduler.run(options);
      });
      expect(actual.runs.map(({ choices }) => choices)).toEqual(expected);
      expect(actual.complete).toBe(true);
    }
  });

  it("discovers a dynamic action only in histories where its emitter takes that branch", () => {
    const result = exploreLab((options) => {
      const scheduler = new LabScheduler();
      let committed = false;
      scheduler.schedule({ ...action("C"), run() { committed = true; } });
      scheduler.schedule({ ...action("R"), run() {
        if (committed) scheduler.schedule(action("M", scheduler.tick, ["R", "C"]));
      } });
      return scheduler.run(options);
    });
    expect(result.runs.map(({ choices }) => choices)).toEqual([["C", "R", "M"], ["R", "C"]]);
  });

  it("leaves unseen prefixes at a run cap and separates them from incompletely executed runs", () => {
    expect(exploreLab(forest, { maxRuns: 0 })).toMatchObject({ runs: [], complete: false, pendingPrefixes: 1 });
    expect(exploreLab(forest, { maxRuns: 1 })).toMatchObject({
      complete: false, pendingPrefixes: 2, counts: { terminal: 1, blocked: 0, truncated: 0 },
    });
    const partial = exploreLab(forest, { limits: { maxSteps: 1 } });
    expect(partial).toMatchObject({ complete: false, pendingPrefixes: 0, counts: { terminal: 0, blocked: 0, truncated: 2 } });
  });

  it("draws reproducible seeded samples within the run cap and tracks unexecuted samples", () => {
    const sample = () => exploreLab((options) => ({ ...forest(options), seed: options.seed }), {
      seed: Number.MAX_SAFE_INTEGER, samples: 4, maxRuns: 3,
    });
    const result = sample();
    expect(result).toEqual(sample());
    expect(result).toMatchObject({ complete: false, mode: "sampled", pendingPrefixes: 0, remainingSamples: 1 });
    expect(result.runs.map(({ seed }) => seed)).toEqual([Number.MAX_SAFE_INTEGER, 0, 1]);
    expect(new Set(result.runs.map(({ choices }) => choices.join(""))).size).toBeGreaterThan(1);
    for (const run of result.runs) expect(forest({ replayChoices: run.choices }).choices).toEqual(run.choices);
    expect(() => exploreLab(forest, { samples: 2 })).toThrow(/seed/i);
  });
});

describe("causality, delivery and budgets", () => {
  it("checks each batch before callbacks, including disconnected invalid graph components", () => {
    for (const invalid of [
      [action("a", 0, ["x"])],
      [action("a", 0, ["b"]), action("b", 0, ["a"])],
      [action("a", 0, ["b"]), action("b", 1)],
    ]) {
      const scheduler = new LabScheduler();
      const callback = vi.fn();
      scheduler.schedule({ ...action("independent"), run: callback });
      for (const item of invalid) scheduler.schedule(item);
      expect(() => scheduler.run()).toThrow();
      expect(callback).not.toHaveBeenCalled();
    }
    const scheduler = new LabScheduler();
    scheduler.schedule({ ...action("start"), run() { scheduler.schedule(action("late", 0, ["missing"])); } });
    expect(() => scheduler.run()).toThrow(/missing parent/i);
  });

  it("admits a waiting delivery at the current tick after a later release opens its channel", () => {
    const scheduler = new LabScheduler();
    const times: number[] = [];
    let open = false;
    scheduler.schedule({ ...action("waiting", 1), enabled: () => open, run: () => times.push(scheduler.tick) });
    scheduler.schedule({ ...action("release", 6), run() { open = true; } });
    scheduler.schedule(action("peer", 6, ["release"]));
    const result = scheduler.run({ prefix: ["release", "waiting"] });
    expect(result.status).toBe("terminal");
    expect(result.alternatives).toEqual([["release"], ["peer", "waiting"], ["peer"]]);
    expect(times).toEqual([6]);
  });

  it("reports a permanently closed channel as blocked with no false terminal", () => {
    const result = exploreLab((options) => {
      const scheduler = new LabScheduler();
      scheduler.schedule({ ...action("undelivered"), enabled: () => false });
      return scheduler.run(options);
    });
    expect(result.counts.blocked).toBe(1);
    expect(result.complete).toBe(false);
    expect(result.runs[0]).toMatchObject({ choices: [], alternatives: [], reason: expect.stringContaining("undelivered") });
  });

  it("enforces step and choice limits only when another matching step would be required", () => {
    expect(new LabScheduler().run({ limits: { maxSteps: 0 } }).status).toBe("terminal");
    expect(forest({ limits: { maxSteps: 0 } })).toMatchObject({ status: "truncated", choices: [] });
    expect(forest({ limits: { maxSteps: 3 } }).status).toBe("terminal");
    expect(forest({ limits: { maxDecisions: 1 } })).toMatchObject({ status: "truncated", choices: ["A"] });
    const forced = new LabScheduler();
    forced.schedule(action("only"));
    expect(forced.run({ limits: { maxDecisions: 0 } }).status).toBe("terminal");
  });

  it.each(["restart", "duplicate"] as const)("stops at an exhausted %s frontier before another action can disable it", (resource) => {
    const scheduler = new LabScheduler();
    let enabled = true;
    scheduler.schedule({ ...action("expensive"), resource, enabled: () => enabled });
    scheduler.schedule({ ...action("affordable"), run() { enabled = false; } });
    const result = scheduler.run({ limits: { maxRestarts: 0, maxDuplicates: 0 }, replayChoices: [] });
    expect(result).toMatchObject({ status: "truncated", choices: [] });
    expect(enabled).toBe(true);
  });

  it("charges a resource on delivery and drains independent future work only while within limits", () => {
    const scheduler = new LabScheduler();
    scheduler.schedule({ ...action("first"), resource: "duplicate" });
    scheduler.schedule({ ...action("second", 1, ["first"]), resource: "duplicate" });
    scheduler.schedule(action("future", 3));
    expect(scheduler.run({ limits: { maxDuplicates: 1 } })).toMatchObject({
      choices: ["first"], alternatives: [["first"]], status: "truncated", reason: "maxDuplicates exhausted",
    });
  });

  it("rejects illegal, incomplete and trailing replay choices including at the exact cap", () => {
    expect(() => forest({ prefix: ["B"] })).toThrow(/step 1/i);
    expect(() => forest({ replayChoices: ["A"] })).toThrow(/step 2/i);
    expect(() => forest({ replayChoices: ["A", "B", "C", "D"] })).toThrow(/step 4/i);
    expect(() => forest({ replayChoices: ["A", "B"], limits: { maxSteps: 1 } })).toThrow(/step 2/i);
    expect(forest({ replayChoices: ["A"], limits: { maxSteps: 1 } }).status).toBe("truncated");
    expect(() => forest({ prefix: [], replayChoices: [] })).toThrow();
    expect(forest({ preferredChoices: ["missing", "B", "C"] }).choices).toEqual(["C", "A", "B"]);
  });

  it("rejects invalid metadata, duplicate IDs, past ticks and invalid numeric allowances", () => {
    for (const invalid of [action("non-ascii-ø"), action(""), action("a", -1), action("a", 1.2), action("a", 0, ["x", "x"])]) {
      expect(() => new LabScheduler().schedule(invalid)).toThrow();
    }
    for (const invalid of [-1, 0.1, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => forest({ limits: { maxRestarts: invalid } })).toThrow(/maxRestarts/);
      expect(() => exploreLab(forest, { maxRuns: invalid })).toThrow(/maxRuns/);
      expect(() => forest({ seed: invalid })).toThrow(/seed/);
    }
    const duplicate = new LabScheduler();
    duplicate.schedule(action("repeat"));
    expect(() => duplicate.schedule(action("repeat"))).toThrow(/duplicate/i);
    const backwards = new LabScheduler();
    backwards.schedule({ ...action("start", 3), run: () => backwards.schedule(action("old", 2)) });
    expect(() => backwards.run()).toThrow(/past/i);
  });
});
