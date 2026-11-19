import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAgentAdapter, parseScenario, type Scenario } from "../src/lab/contract.js";
import { exploreLab, type LabRunOptions } from "../src/lab/engine.js";
import { builtinPolicy } from "../src/lab/policy.js";
import { inspectLab } from "../src/lab/verify.js";
import { executeWorld } from "../src/lab/world.js";

function fixture(name: string): Scenario {
  const url = new URL(`../examples/lab/${name}.json`, import.meta.url);
  return parseScenario(JSON.parse(readFileSync(url, "utf8")));
}

function observe(scenario: Scenario, options: LabRunOptions = {}) {
  const run = executeWorld(scenario, builtinPolicy(scenario.policy), options);
  expect(run.status).toBe("terminal");
  return {
    facts: (kind: string) => run.events.filter(event => event.kind === kind),
    report: inspectLab(run.events, scenario, true),
  };
}

describe("published booking scenarios", () => {
  it("suppresses the unsent Tuesday create and amends an already committed one", () => {
    const scenario = fixture("correction");
    const inFlight = observe(scenario);
    expect(inFlight.report.verdict).toBe("pass");
    expect(inFlight.facts("provider.committed").map(e => [e.payload.bookingId, e.payload.day]))
      .toEqual([["booking-1", "Tuesday"], ["booking-1", "Thursday"]]);

    // Stretch storage latency so the correction arrives before the first write acknowledgement.
    const beforeSend = observe({ ...scenario, delays: { ...scenario.delays, store: 5 } });
    expect(beforeSend.report.verdict).toBe("pass");
    expect(beforeSend.facts("provider.committed").map(e => e.payload.day)).toEqual(["Thursday"]);
    expect(beforeSend.facts("device.playbackStarted")).toMatchObject([{ payload: { claim: { day: "Thursday" } } }]);
    const readOnly = observe({ ...scenario, provider: { ...scenario.provider, amend: false }, expectation: "review" });
    expect(readOnly.report.verdict).toBe("pass");
    expect(readOnly.facts("provider.committed").map(e => e.payload.day)).toEqual(["Tuesday"]);
    expect(readOnly.facts("agent.reviewRequested")).toHaveLength(1);
  });

  it("reconciles the lost create receipt and the durable Thursday correction", () => {
    const run = observe(fixture("recovery"));
    expect(run.report.verdict).toBe("pass");
    expect(run.facts("transport.dropped")).toMatchObject([{ payload: { channel: "providerReply", day: "Tuesday" } }]);
    expect(run.facts("agent.restarted")).toMatchObject([{ payload: { snapshot: { day: "Thursday" } } }]);
    expect(run.facts("provider.queried")).toMatchObject([{ payload: { day: "Tuesday", bookingId: "booking-1" } }]);
    expect(run.facts("provider.committed").map(e => [e.payload.bookingId, e.payload.day]))
      .toEqual([["booking-1", "Tuesday"], ["booking-1", "Thursday"]]);
    expect(run.facts("device.playbackStarted")).toMatchObject([{ payload: { epoch: 2, claim: { day: "Thursday" } } }]);
  });

  it("uses the provider's declared capability under the same lost receipt", () => {
    const scenario = fixture("opaque");
    const unknown = observe(scenario);
    expect(unknown.report.verdict).toBe("pass");
    expect(unknown.facts("request.sent")).toHaveLength(1);
    expect(unknown.facts("agent.reviewRequested")).toHaveLength(1);
    expect(unknown.facts("claim.emitted")).toEqual([]);
    const keyed = observe({ ...scenario, expectation: "confirmed", provider: { ...scenario.provider, idempotent: true } });
    expect(keyed.report.verdict).toBe("pass");
    expect(keyed.facts("provider.committed")).toMatchObject([{ payload: { bookingId: "booking-1" } }]);
    expect(keyed.facts("provider.reused")).toMatchObject([{ payload: { bookingId: "booking-1" } }]);
  });

  it("recovers the committed write or rejects its stale epoch, depending on one legal choice", () => {
    const scenario = fixture("epoch-race");
    const accepted = observe(scenario);
    const rejected = observe(scenario, { preferredChoices: ["restart"] });
    expect(accepted.facts("agent.restarted")).toMatchObject([{ payload: { revision: 1, snapshot: { day: "Thursday" } } }]);
    expect(rejected.facts("agent.restarted")).toMatchObject([{ payload: { revision: 0, snapshot: null } }]);
    expect(rejected.facts("store.rejected")).toMatchObject([{ payload: { epoch: 1, reason: "stale-epoch" } }]);
    for (const run of [accepted, rejected]) {
      expect(run.report.verdict).toBe("pass");
      expect(run.facts("transport.stale")).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ channel: "storeAck", epoch: 1 }) }));
      expect(run.facts("provider.committed")).toMatchObject([{ payload: { day: "Thursday" } }]);
    }
  });

  it("preserves an in-flight provider create on both sides of restart", () => {
    const scenario = fixture("commit-race");
    for (const restartFirst of [false, true]) {
      const run = executeWorld(scenario, builtinPolicy("safe"), { preferredChoices: restartFirst ? ["restart"] : [] });
      const order = run.events.filter(e => e.tick === 7 && ["provider.committed", "agent.restarted"].includes(e.kind));
      expect(order.map(e => e.kind)).toEqual(restartFirst
        ? ["agent.restarted", "provider.committed"] : ["provider.committed", "agent.restarted"]);
      expect(run.events.filter(e => e.kind === "provider.committed")).toMatchObject([{ payload: { epoch: 1, bookingId: "booking-1" } }]);
      expect(run.events.filter(e => e.kind === "provider.queried")).toMatchObject([{ payload: { epoch: 2, bookingId: "booking-1" } }]);
      expect(inspectLab(run.events, scenario, run.status === "terminal").verdict).toBe("pass");
    }
  });

  it("distinguishes a precommit provider failure from a lost receipt for an actual commitment", () => {
    const scenario = fixture("commit-race");
    const failBeforeCommit = observe({ ...scenario, actions: [
      { kind: "fail-next-provider", id: "transient-failure", tick: 0, parents: [] },
      ...scenario.actions.filter(a => a.kind === "input"),
    ] });
    expect(failBeforeCommit.report.verdict).toBe("pass");
    expect(failBeforeCommit.facts("provider.failed")).toMatchObject([{ payload: { bookingId: null } }]);
    const rejection = failBeforeCommit.facts("reply.delivered").find(e => e.payload.outcome === "rejected");
    expect(rejection?.payload.bookingId).toBeNull();
    expect(failBeforeCommit.facts("provider.committed")).toMatchObject([{ payload: { day: "Thursday", bookingId: "booking-1" } }]);
    expect(rejection!.tick).toBeLessThan(failBeforeCommit.facts("provider.committed")[0]!.tick);
  });

  it("separates a lost one-time correction from redelivery after a lost input acknowledgement", () => {
    const once = observe(fixture("once-loss"));
    expect(once.report.verdict).toBe("pass");
    expect(once.facts("agent.restarted")).toMatchObject([{ payload: { snapshot: { day: "Tuesday" } } }]);
    expect(once.facts("store.rejected")).toMatchObject([{ payload: { snapshot: { day: "Thursday" } } }]);
    expect(once.facts("agent.reconfirmRequested")).toHaveLength(1);
    expect(once.facts("claim.emitted").filter(e => e.payload.epoch === 2)).toHaveLength(0);

    const redelivered = observe(fixture("redelivery"));
    expect(redelivered.report.verdict).toBe("pass");
    expect(redelivered.facts("input.delivered").filter(e => e.payload.inputId === "request-thursday")
      .map(e => e.payload.epoch)).toEqual([1, 2]);
    expect(redelivered.facts("store.committed").map(e => e.payload.revision)).toEqual([1, 2]);
    expect(redelivered.facts("provider.committed").map(e => e.payload.day)).toEqual(["Tuesday", "Thursday"]);
  });

  it("discards stale arrivals after flush and records already-playing audio as a remnant", () => {
    const scenario = fixture("device-flush");
    const late = observe(scenario);
    expect(late.report.verdict).toBe("pass");
    expect(late.facts("device.stale")).toMatchObject([{ payload: { claim: { day: "Tuesday" } } }]);
    expect(late.facts("device.playbackStarted")).toMatchObject([{ payload: { claim: { day: "Thursday" } } }]);
    const playing = observe({ ...scenario, playbackTicks: 20, actions: scenario.actions.filter(a => a.kind === "input") });
    expect(playing.report.verdict).toBe("pass");
    expect(playing.facts("device.remnant")).toMatchObject([{ payload: { claim: { day: "Tuesday" } } }]);
    const [first, last] = playing.facts("device.playbackStarted");
    expect(first!.tick).toBeLessThan(playing.facts("device.remnant")[0]!.tick);
    expect(last!.payload.claim).toMatchObject({ day: "Thursday" });
  });

  it("drains provider and device effects after the caller leaves", () => {
    const run = observe(fixture("post-end"));
    expect(run.report.verdict).toBe("pass");
    const end = run.facts("call.ended")[0]!.tick;
    expect(run.facts("provider.committed")[0]!.tick).toBeGreaterThan(end);
    expect(run.facts("device.playbackStarted")[0]!.tick).toBeGreaterThan(end);
  });

  it("exposes the same premature acknowledgement with and without optional perturbations", () => {
    const scenario = fixture("reduce");
    const original = observe(scenario).report;
    const reduced = observe({ ...scenario, actions: scenario.actions.filter(a => !a.optional) }).report;
    expect(original.findings[0]).toMatchObject({ property: "input.durable-ack" });
    expect(reduced.findings[0]?.signature).toBe(original.findings[0]!.signature);
  });

  it("enumerates the two actual timer/correction orders in the external customer agent", async () => {
    const scenario = fixture("customer-race");
    const url = new URL("../examples/lab/customer-agent.mjs", import.meta.url);
    const adapter = parseAgentAdapter((await import(url.href)).default);
    const result = exploreLab(options => executeWorld(scenario, adapter, options), { maxRuns: 8 });
    expect(result.complete).toBe(true);
    expect(result.runs).toHaveLength(2);
    const histories = result.runs.map(run => {
      expect(run.events.filter(e => e.kind === "provider.committed")).toMatchObject([{ payload: { day: "Tuesday" } }]);
      expect(run.events.filter(e => e.kind === "reply.delivered")).toHaveLength(0);
      const order = run.events.filter(e => e.tick === 10 && ["timer.fired", "input.delivered"].includes(e.kind))
        .map(e => e.kind);
      if (order[0] === "timer.fired") {
        const actions = run.events.filter(e => e.tick === 10 && ["input.delivered", "agent.reviewRequested", "claim.emitted"].includes(e.kind));
        expect(actions.map(e => e.kind)).toEqual(["agent.reviewRequested", "input.delivered", "agent.reviewRequested"]);
        expect(actions[2]!.payload.reason).toContain("the caller now wants Thursday");
      }
      const report = inspectLab(run.events, scenario, true);
      return { order, verdict: report.verdict, first: report.findings[0]?.property };
    });
    expect(histories).toEqual(expect.arrayContaining([
      { order: ["timer.fired", "input.delivered"], verdict: "pass", first: undefined },
      { order: ["input.delivered", "timer.fired"], verdict: "fail", first: "claim.supported" },
    ]));
  });
});
