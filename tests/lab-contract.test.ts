import { describe, expect, it } from "vitest";
import { commandJsonSchema, parseAgentAdapter, parseAgentCommands, parseAgentStep, parseScenario, scenarioJsonSchema } from "../src/lab/contract.js";

const fixture = {
  schemaVersion: 1, id: "reservation", provider: { idempotent: true, query: true, amend: false },
  delivery: "recoverable", expectation: "confirmed",
  actions: [{ id: "caller-initial", kind: "input", tick: 0, inputId: "order:1", day: "Tuesday" }],
};
const crash = { id: "stop", tick: 2, kind: "crash" };

describe("public scenario contract", () => {
  it("provides canonical defaults and copies the caller's data", () => {
    const parsed = parseScenario({ ...fixture, delays: { store: 0 } });
    expect(parsed).toMatchObject({
      policy: "safe", fifo: [], playbackTicks: 2, delays: { store: 0, storeAck: 1, provider: 1 },
      actions: [{ id: "caller-initial", parents: [] }],
    });
    expect(parseScenario(parsed)).toEqual(parsed);
    expect(parsed.provider).not.toBe(fixture.provider);
    expect(scenarioJsonSchema).toMatchObject({ type: "object", additionalProperties: false });
    expect(commandJsonSchema).toHaveProperty("$schema");
  });

  it.each([
    { schemaVersion: 2 },
    { policy: "../adapter.mjs" },
    { adapterPath: "./adapter.mjs" },
    { delays: { provider: -1 } },
    { provider: { idempotent: true, amend: true } },
    { fifo: ["provider", "provider"] },
    { actions: [{ ...crash, tick: 1.5 }] },
    { actions: [{ ...crash, tick: Number.MAX_SAFE_INTEGER + 1 }] },
    { actions: [{ ...crash, group: "optional-only" }] },
    { actions: [{ ...crash, kind: "drop-next", channel: "unknown" }] },
    { actions: [{ ...fixture.actions[0], sourceRevision: 20 }] },
  ])("rejects an invalid field or action (%j)", change => {
    expect(() => parseScenario({ ...fixture, ...change })).toThrow();
  });

  it("validates the DAG before execution regardless of declaration order", () => {
    const restart = { id: "start", kind: "restart", tick: 3, parents: ["stop"] };
    expect(parseScenario({ ...fixture, actions: [restart, crash] }).actions[0]?.id).toBe("start");
    for (const [actions, message] of [
      [[crash, crash], /Duplicate action/],
      [[restart], /Missing parent/],
      [[crash, { ...restart, parents: ["stop", "stop"] }], /Duplicate parent/],
      [[crash, { ...restart, tick: 1 }], /precedes/],
      [[{ ...crash, parents: ["start"] }, { ...restart, tick: 2 }], /cycle/],
    ] as const) {
      expect(() => parseScenario({ ...fixture, actions })).toThrow(message);
    }
  });

  it("requires stable payloads across deliveries of the same logical input", () => {
    const original = fixture.actions[0]!;
    const duplicate = { ...original, id: "repeat" };
    expect(parseScenario({ ...fixture, actions: [original, duplicate] }).actions).toHaveLength(2);
    expect(() => parseScenario({ ...fixture, actions: [original, { ...duplicate, day: "Thursday" }] }))
      .toThrow(/Conflicting content/);
  });

  it("accepts domain signals with isolated JSON data and no booking progress requirement", () => {
    const data = { lines: ["a", "b"], approved: true };
    const signal = { kind: "signal", name: "approval.accepted", id: "accept", tick: 1, data };
    const parsed = parseScenario({ ...fixture, expectation: "observe", actions: [signal] });
    data.lines.push("late");
    expect(parsed.actions[0]).toMatchObject({ data: { lines: ["a", "b"], approved: true } });
    expect(parseScenario({ ...fixture, actions: [{ kind: "signal", name: "prepare", id: "prepare", tick: 1 }] }).actions)
      .toMatchObject([{ kind: "signal", data: {} }]);
    expect(() => parseScenario({ ...fixture, actions: [{ ...signal, data: [] }] })).toThrow();
    expect(() => parseScenario({ ...fixture, actions: [{ ...signal, data: { approved: undefined } }] })).toThrow();
    const unusual = JSON.parse('{"__proto__":{"nested":{"__proto__":"a domain key"}}}');
    const received = parseScenario({ ...fixture, actions: [{ ...signal, data: unusual }] }).actions[0];
    expect(received?.kind === "signal" && JSON.stringify(received.data)).toBe(JSON.stringify(unusual));
    const circular: Record<string, unknown> = {};
    circular.loop = circular;
    expect(() => parseScenario({ ...fixture, actions: [{ ...signal, data: circular }] })).toThrow(/JSON object/);
  });
});

describe("trusted cooperative adapter boundary", () => {
  it("accepts a synchronous adapter and preserves its methods' receiver", () => {
    const adapter = {
      id: "sample", version: "1.0", init() { return this.id; },
      step(state: unknown) { return { next: state, commands: [] }; },
    };
    const parsed = parseAgentAdapter(adapter);
    expect(parsed).toBe(adapter);
    expect(parsed.init({ epoch: 1, revision: 0, snapshot: null, provider: fixture.provider, delivery: "once" })).toBe("sample");
    expect(parseAgentStep(parsed.step("sample", { kind: "start" }))).toEqual({ next: "sample", commands: [] });
    expect(() => parseAgentAdapter({ ...adapter, step: [] })).toThrow();
    expect(() => parseAgentStep(Promise.resolve({ next: "later", commands: [] }))).toThrow();
    expect(() => parseAgentStep({ next: Promise.resolve("later"), commands: [] })).toThrow(/synchronously/);
    expect(() => parseAgentStep({ commands: [] })).toThrow();
  });

  it("checks effect envelopes and copies JSON snapshots at the boundary", () => {
    const draft = { inputIds: ["in-1"], revision: 1 };
    const command = { kind: "store", requestId: "write:1", expectedRevision: 0, snapshot: draft };
    const [validated] = parseAgentCommands([command]);
    draft.inputIds.push("late-change");
    expect(validated).toMatchObject({ snapshot: { inputIds: ["in-1"] } });
    expect(parseAgentCommands([{ kind: "observe", name: "approval", data: { granted: true } }]))
      .toEqual([{ kind: "observe", name: "approval", data: { granted: true } }]);
    for (const invalid of [
      { ...command, snapshot: { day: undefined } },
      { ...command, snapshot: { count: Infinity } },
      { ...command, epoch: 9 },
      { kind: "speech", generation: -1, claim: { bookingId: "b", day: "Tuesday" } },
      { kind: "provider", requestId: "r", operation: { kind: "amend", key: "op", day: "Tuesday" } },
      { kind: "provider", requestId: "r", operation: { kind: "query", key: "op", bookingId: "b" } },
      { kind: "review", reason: "   " },
      { kind: "timer", timerId: "tick", delayTicks: 1.5 },
      { kind: "provider.committed", bookingId: "b" },
      { kind: "observe", name: "approval", data: { invalid: BigInt(1) } },
      { kind: "observe", name: "approval" },
      { kind: "observe", name: "approval", data: {}, actor: "provider" },
    ]) {
      expect(() => parseAgentStep({ next: null, commands: [invalid] })).toThrow();
    }
  });
});
