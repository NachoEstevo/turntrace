import { expect, it } from "vitest";
import { parseScenario, type LabEvent, type Scenario } from "../src/lab/contract.js";
import type { LabRunOptions } from "../src/lab/engine.js";
import { builtinPolicy } from "../src/lab/policy.js";
import { inspectLab } from "../src/lab/verify.js";
import { executeWorld } from "../src/lab/world.js";

const healthy = { idempotent: true, query: true, amend: true };
const opaque = { idempotent: false, query: false, amend: false };
const tuesday = { id: "tuesday", kind: "input", inputId: "first", day: "Tuesday", tick: 0 };
const thursday = (tick: number) => ({ id: "thursday", kind: "input", inputId: "correction", day: "Thursday", tick });
function interruption(tick: number, label = "first") {
  const crash = `crash.${label}`;
  return [{ id: crash, kind: "crash", tick }, { id: `boot.${label}`, kind: "restart", tick: tick + 1, parents: [crash] }];
}
function scenario(actions: unknown[], overrides: Record<string, unknown> = {}) {
  return parseScenario({ schemaVersion: 1, id: "cut", provider: healthy, delivery: "recoverable", expectation: "confirmed", actions, ...overrides });
}
function run(input: Scenario, options: LabRunOptions = {}) {
  const execution = executeWorld(input, builtinPolicy("safe"), options);
  expect(execution.status).toBe("terminal");
  return { ...execution, report: inspectLab(execution.events, input, true) };
}
function filter(events: LabEvent[], kind: string) {
  return events.filter((event) => event.kind === kind);
}

it("preserves a single Thursday amendment on both sides of its commit racing with a crash", () => {
  const input = scenario([tuesday, thursday(9), ...interruption(13)]);
  const initial = run(input);
  const amend = filter(initial.events, "provider.committed").find((e) => e.payload.day === "Thursday")!.id;
  const tie = initial.alternatives.findIndex(ids => ids.includes(amend) && ids.includes("crash.first"));
  expect(tie).toBeGreaterThan(0);
  const base = initial.choices.slice(0, tie);
  for (const first of ["crash.first", amend]) {
    const { events, report, choices } = run(input, { prefix: [...base, first] });
    expect(choices[tie]).toBe(first);
    expect(report.findings).toEqual([]);
    expect(report.bookings).toEqual([{ bookingId: "booking-1", day: "Thursday" }]);
    expect(filter(events, "provider.committed").map(e => e.payload.day)).toEqual(["Tuesday", "Thursday"]);
    expect(filter(events, "agent.restarted")[0]?.payload.snapshot).toMatchObject({ day: "Thursday", intentRevision: 2 });
    expect(report.played.at(-1)).toMatchObject({ day: "Thursday", bookingId: "booking-1" });
  }
});

it("repeats a reasoned opaque handoff after a second crash with no new create or confirmation", () => {
  const input = scenario([
    { id: "lose", kind: "drop-next", channel: "providerReply", tick: 0 },
    tuesday, ...interruption(9), ...interruption(14, "second"),
  ], { provider: opaque, expectation: "review" });
  const { events, report } = run(input);
  expect(report.findings).toEqual([]);
  expect(filter(events, "agent.reviewRequested").map(e => e.payload.epoch)).toEqual([2, 3]);
  expect(filter(events, "request.sent")).toHaveLength(1);
  expect(report.bookings).toEqual([{ bookingId: "booking-1", day: "Tuesday" }]);
  expect(report.played).toEqual([]);
});

it("reconciles a redelivered correction after losing both the caller acknowledgement and the amendment receipt", () => {
  const input = scenario([
    tuesday, thursday(10),
    { id: "lose.input", kind: "drop-next", channel: "inputAck", tick: 9 },
    { id: "lose.reply", kind: "drop-next", channel: "providerReply", tick: 9 },
    ...interruption(17),
  ]);
  const { events, report } = run(input);
  expect(filter(events, "transport.dropped").map(e => e.payload.channel).sort()).toEqual(["inputAck", "providerReply"]);
  expect(filter(events, "input.delivered").filter(e => e.payload.inputId === "correction").map(e => e.payload.epoch)).toEqual([1, 2]);
  expect(filter(events, "store.committed").map(e => e.payload.revision)).toEqual([1, 2]);
  expect(filter(events, "provider.committed").map(e => e.payload.day)).toEqual(["Tuesday", "Thursday"]);
  expect(report.findings).toEqual([]);
  expect(report.played.at(-1)?.day).toBe("Thursday");
});

it("uses delivered evidence when a healthy provider consistently replies after the agent's first timeout", () => {
  const { events, report } = run(scenario([thursday(0)], { delays: { providerReply: 16 } }));
  const firstTimeout = filter(events, "timer.fired")[0]!;
  const firstReceipt = filter(events, "reply.delivered")[0]!;
  expect(firstReceipt.tick).toBeGreaterThan(firstTimeout.tick);
  expect(report.findings).toEqual([]);
  expect(report.review).toBeNull();
  expect(report.bookings).toEqual([{ bookingId: "booking-1", day: "Thursday" }]);
  expect(report.played.at(-1)?.day).toBe("Thursday");
});

it("creates the durable booking when a post-restart negative lookup arrives after the timeout", () => {
  const input = scenario([tuesday, thursday(2), ...interruption(4)], { delays: { providerReply: 15 } });
  const { events, report } = run(input);
  const restart = events.findIndex(e => e.kind === "agent.restarted");
  expect(filter(events.slice(0, restart), "request.sent")).toEqual([]);
  expect(events[restart]!.payload.snapshot).toMatchObject({ day: "Thursday", intentRevision: 2 });
  const missed = filter(events, "reply.delivered").find(e => e.payload.outcome === "missing")!;
  expect(missed.tick).toBeGreaterThan(filter(events, "timer.fired")[0]!.tick);
  expect(report.findings).toEqual([]);
  expect(report.bookings).toEqual([{ bookingId: "booking-1", day: "Thursday" }]);
  expect(report.played.at(-1)?.day).toBe("Thursday");
});

it("retries an explicitly rejected, uncommitted create at an opaque provider after it recovers", () => {
  const { events, report } = run(scenario([
    { id: "reject-once", kind: "fail-next-provider", tick: 0 }, thursday(1),
  ], { provider: opaque }));
  expect(filter(events, "provider.failed")).toHaveLength(1);
  const rejected = filter(events, "reply.delivered").find(e => e.payload.outcome === "rejected")!;
  const sends = filter(events, "request.sent");
  expect(sends).toHaveLength(2);
  expect(events.indexOf(sends[1]!)).toBeGreaterThan(events.indexOf(rejected));
  expect(sends[1]!.payload.operation).toEqual(sends[0]!.payload.operation);
  expect(report.findings).toEqual([]);
  expect(report.bookings).toEqual([{ bookingId: "booking-1", day: "Thursday" }]);
  expect(report.played.at(-1)?.day).toBe("Thursday");
});

it("attributes different replies from two deliveries of one attempt to their respective provider results", () => {
  const { events, report } = run(scenario([
    { id: "copy", kind: "duplicate-next", channel: "provider", tick: 0 },
    { id: "reject-first", kind: "fail-next-provider", tick: 0 },
    thursday(1),
  ]));
  const attempt = filter(events, "provider.failed")[0]!.payload.attemptId;
  const replies = filter(events, "reply.delivered").filter(event => event.payload.attemptId === attempt);
  expect(replies.map(event => event.payload.outcome).sort()).toEqual(["committed", "rejected"]);
  expect(report.findings).toEqual([]);
  expect(report.bookings).toEqual([{ bookingId: "booking-1", day: "Thursday" }]);
  expect(report.played.at(-1)?.day).toBe("Thursday");
});
