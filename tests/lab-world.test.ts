import { describe, expect, it } from "vitest";
import { parseScenario, type AgentAdapter, type AgentCommand, type DeliveredEvent, type RecoveryContext } from "../src/lab/contract.js";
import { executeWorld } from "../src/lab/world.js";
import { exploreLab } from "../src/lab/engine.js";

const zero = { input: 0, store: 0, storeAck: 0, inputAck: 0, provider: 0, providerReply: 0, speech: 0, playback: 0, flush: 0 };
function scenario(actions: unknown[], options: Record<string, unknown> = {}) {
  return parseScenario({
    id: "world-test", schemaVersion: 1, provider: { query: true, idempotent: true, amend: true },
    delivery: "once", expectation: "settled", delays: zero, actions, ...options,
  });
}
function adapter(decide: (context: RecoveryContext, input: DeliveredEvent) => AgentCommand[]): AgentAdapter<RecoveryContext> {
  return { id: "probe", version: "1", init: context => context, step: (state, input) => ({ next: state, commands: decide(state, input) }) };
}
const initial = { kind: "input", id: "ask", inputId: "initial", day: "Tuesday", tick: 0 };
const outage = [{ kind: "crash", id: "crash", tick: 2 }, { kind: "restart", id: "restart", tick: 3 }];
const writing = adapter((state, input) => input.kind === "input"
  ? [{ kind: "store", requestId: "persist", expectedRevision: state.revision, snapshot: { day: input.day } }] : []);

describe("agent recovery boundaries", () => {
  it.each([
    [1, { day: "Tuesday" }, "store.committed"],
    [4, null, "store.rejected"],
  ] as const)("fences a store apply with release tick %s against the boot epoch", (delay, recovered, outcome) => {
    const run = executeWorld(scenario([initial, ...outage], { delays: { ...zero, store: delay, storeAck: 5 } }), writing);
    expect(run.status).toBe("terminal");
    expect(run.events.find(e => e.kind === "agent.restarted")?.payload).toMatchObject({
      epoch: 2, snapshot: recovered, revision: recovered ? 1 : 0,
    });
    expect(run.events.find(e => e.kind === outcome)?.payload).toMatchObject(recovered ? { accepted: true } : { reason: "stale-epoch" });
    expect(run.events.find(e => e.kind === "transport.stale")?.payload).toMatchObject({ channel: "storeAck", epoch: 1 });
    expect(run.events.filter(e => e.kind === "store.ackDelivered")).toEqual([]);
  });

  it("allows one outstanding write per instance and compares revisions at apply", () => {
    const probe = adapter((state, input) => {
      if (input.kind === "input") return ["a", "b"].map(requestId => ({
        kind: "store", requestId, snapshot: { value: requestId }, expectedRevision: state.revision,
      }));
      if (input.kind === "store-ack" && input.requestId === "a" && input.accepted) {
        return [{ kind: "store", requestId: "old", snapshot: { value: 3 }, expectedRevision: 0 }];
      }
      return [];
    });
    const run = executeWorld(scenario([initial], { fifo: ["store", "storeAck"] }), probe);
    expect(run.events.filter(e => e.kind === "store.committed")).toHaveLength(1);
    expect(run.events.filter(e => e.kind === "store.rejected").map(e => e.payload.reason)).toEqual(["write-outstanding", "revision-mismatch"]);
  });

  it.each([["recoverable", [1, 2]], ["once", [1]]] as const)(
    "%s input retains its logical identity across a lost input acknowledgment", (delivery, expectedEpochs) => {
      const arm = { kind: "drop-next", id: "drop", tick: 0, channel: "inputAck" };
      const secondOutage = [{ kind: "crash", id: "crash2", tick: 4 }, { kind: "restart", id: "restart2", tick: 5 }];
      const run = executeWorld(scenario([arm, { ...initial, parents: ["drop"] }, ...outage, ...secondOutage], { delivery }),
        adapter((_, input) => input.kind === "input" ? [{ kind: "input-ack", inputId: input.inputId }] : []));
      const delivered = run.events.filter(e => e.kind === "input.delivered");
      expect(delivered.map(e => e.payload.epoch)).toEqual(expectedEpochs);
      expect(delivered.every(e => e.payload.inputId === "initial" && e.parents.includes("ask"))).toBe(true);
      expect(run.events.find(e => e.kind === "transport.dropped")?.payload.channel).toBe("inputAck");
    });

  it("invalidates old timers and replies but drains the create after call end", () => {
    const run = executeWorld(scenario([initial, ...outage, { kind: "end-call", id: "leave", tick: 1 }], {
      delays: { ...zero, provider: 6 },
    }), adapter((_, input) => input.kind === "input" ? [
      { kind: "provider", requestId: "request", operation: { kind: "create", key: "logical", day: input.day } },
      { kind: "timer", timerId: "private", delayTicks: 8 },
    ] : []));
    expect(run.events.find(e => e.kind === "provider.committed")?.tick).toBe(6);
    expect(run.events.find(e => e.kind === "timer.stale")?.tick).toBe(8);
    expect(run.events.find(e => e.kind === "transport.stale")?.payload.channel).toBe("providerReply");
    expect(run.events.some(e => ["timer.fired", "reply.delivered"].includes(e.kind))).toBe(false);
  });

  it("preserves source order when an older input arrives late, including copies after restart", () => {
    const run = executeWorld(scenario([
      { kind: "delay-next", id: "slow", tick: 0, channel: "input", delayTicks: 3 },
      { ...initial, parents: ["slow"] },
      { kind: "input", id: "correct", inputId: "corrected", day: "Thursday", tick: 1 },
      { kind: "crash", id: "off", tick: 4 },
      { kind: "delay-next", id: "slowAgain", tick: 5, channel: "input", delayTicks: 4 },
      { kind: "duplicate-next", id: "copy", tick: 5, channel: "input" },
      { kind: "restart", id: "on", tick: 6 },
      { ...initial, id: "repeatOriginal", tick: 11 },
    ], { delivery: "recoverable" }), adapter((_, input) => input.kind === "input"
      ? [{ kind: "observe", name: "heard", data: { inputId: input.inputId, revision: input.sourceRevision } }]
      : []));
    expect(run.events.filter(e => e.kind === "caller.spoke").map(e => e.payload.sourceRevision)).toEqual([1, 2, 1]);
    const delivered = run.events.filter(e => e.kind === "input.delivered");
    expect(delivered.map(e => [e.tick, e.payload.epoch, e.payload.sourceRevision])).toEqual([
      [1, 1, 2], [3, 1, 1], [6, 2, 2], [10, 2, 1], [10, 2, 1], [11, 2, 1],
    ]);
    expect(run.events.filter(e => e.kind === "agent.observed").map(e => e.payload.data))
      .toEqual(delivered.map(e => ({ inputId: e.payload.inputId, revision: e.payload.sourceRevision })));
  });
});

it("flush preserves an already-playing remnant and prevents queued and late fragments from starting", () => {
  const run = executeWorld(scenario([
    initial, { ...initial, id: "queued", inputId: "queued", tick: 1 },
    { kind: "delay-next", id: "delay", channel: "speech", delayTicks: 5, tick: 2 },
    { ...initial, id: "late", inputId: "late", tick: 3 },
    { ...initial, id: "correction", day: "Thursday", inputId: "correction", tick: 4 },
  ], { playbackTicks: 7 }), adapter((_, input) => {
    if (input.kind !== "input") return [];
    if (input.day === "Thursday") return [{ kind: "flush", generation: 2 }];
    return [{ kind: "speech", generation: 1, claim: { day: "Tuesday", bookingId: input.inputId } }];
  }));
  expect(run.status).toBe("terminal");
  const marks = run.events.filter(e => e.actor === "device").map(e => [e.kind, e.tick]);
  expect(marks).toEqual([
    ["device.queued", 0], ["device.playbackStarted", 0], ["device.queued", 1],
    ["device.flushed", 4], ["device.remnant", 4], ["device.skipped", 4],
    ["device.playbackEnded", 7], ["device.stale", 8],
  ]);
  const seen = new Set<string>();
  for (const event of run.events) {
    expect(seen.has(event.id)).toBe(false);
    expect(event.parents.every(parent => seen.has(parent))).toBe(true);
    seen.add(event.id);
  }
});

it("delivers only the three causal orders for A before P and an independent U", () => {
  const fixture = scenario(["A", "P", "U"].map(name => ({
    id: name, tick: 1, kind: "signal", name, data: { note: name }, parents: name === "P" ? ["A"] : [],
  })));
  const probe = adapter((_, input) => {
    if (input.kind !== "signal") return [];
    const observation: AgentCommand = { kind: "observe", name: "received", data: { symbol: input.data.note! } };
    input.data.note = "local mutation";
    return [observation];
  });
  const explored = exploreLab(options => executeWorld(fixture, probe, options));
  expect(explored.complete).toBe(true);
  expect(explored.runs.map(run => run.events.filter(e => e.kind === "agent.observed")
    .map(e => (e.payload.data as { symbol: string }).symbol).join("")).sort()).toEqual(["APU", "AUP", "UAP"]);
  expect(fixture.actions[0]).toMatchObject({ data: { note: "A" } });
});

it("records a direct signal addressed to a stopped instance without invoking the adapter", () => {
  const run = executeWorld(scenario([
    { kind: "crash", id: "stop", tick: 1 },
    { kind: "signal", id: "after", name: "A", data: { ready: true }, tick: 2 },
    { kind: "restart", id: "resume", tick: 3 },
  ]), adapter((_, input) => input.kind === "signal" ? [{ kind: "observe", name: "received", data: {} }] : []));
  expect(run.events.find(e => e.kind === "transport.signalUndelivered")?.payload).toMatchObject({ epoch: 1, name: "A" });
  expect(run.events.some(e => e.kind === "agent.observed" || e.kind === "agent.signalDelivered")).toBe(false);
});
