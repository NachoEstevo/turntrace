import { describe, expect, it } from "vitest";
import { parseScenario, type AgentAdapter, type LabEvent, type Scenario } from "../src/lab/contract.js";
import { builtinPolicy } from "../src/lab/policy.js";
import { inspectLab } from "../src/lab/verify.js";
import { executeWorld } from "../src/lab/world.js";

function order(id: string, day: "Tuesday" | "Thursday", tick: number) {
  return { id, kind: "input", inputId: id, day, tick };
}

function trial(actions: object[], policy = "safe", overrides: Partial<Scenario> = {}) {
  const scenario = parseScenario({
    schemaVersion: 1, id: "booking-test", delivery: "recoverable", expectation: "confirmed",
    provider: { idempotent: true, query: true, amend: true }, actions, ...overrides, policy,
  });
  const run = executeWorld(scenario, builtinPolicy(policy));
  return { scenario, events: run.events, report: inspectLab(run.events, scenario, run.status === "terminal") };
}

describe("cooperative policy and observable booking contract", () => {
  it("supersedes a buffered Tuesday before dispatch and persists both input IDs", () => {
    const { events, report } = trial([order("first", "Tuesday", 0), order("second", "Thursday", 1)]);
    expect(report.findings).toEqual([]);
    const commits = events.filter(e => e.kind === "provider.committed");
    expect(commits.map(e => e.payload.day)).toEqual(["Thursday"]);
    expect(events.filter(e => e.kind === "store.committed").at(-1)?.payload.snapshot).toMatchObject({ inputIds: ["first", "second"], intentRevision: 2 });
  });

  it("journals and acknowledges a delayed older input without changing the confirmed Thursday", () => {
    const { events, report, scenario } = trial([
      { kind: "delay-next", id: "late", tick: 0, channel: "input", delayTicks: 30 },
      order("first", "Tuesday", 1), order("second", "Thursday", 2),
    ]);
    expect(report.findings).toEqual([]);
    expect(report.bookings).toEqual([{ bookingId: "booking-1", day: "Thursday" }]);
    expect(events.filter(e => e.kind === "input.delivered").map(e => e.payload.inputId)).toEqual(["second", "first"]);
    const writes = events.filter(e => e.kind === "store.committed");
    const active = { sourceRevision: 2, intentRevision: 2, latestInputId: "second", day: "Thursday", operationKey: "booking.create.2" };
    expect(writes.map(e => e.payload.snapshot)).toEqual([
      expect.objectContaining(active),
      expect.objectContaining({ ...active, receipts: [
        { inputId: "second", day: "Thursday", sourceRevision: 2 }, { inputId: "first", day: "Tuesday", sourceRevision: 1 },
      ] }),
    ]);
    const ack = events.findIndex(e => e.kind === "input.ackRequested" && e.payload.inputId === "first");
    expect(ack).toBeGreaterThan(events.indexOf(writes[1]!));
    for (const kind of ["flush.requested", "request.sent", "provider.committed", "claim.emitted", "device.playbackStarted"]) {
      expect(events.filter(e => e.kind === kind)).toHaveLength(1);
    }
    const late = writes[1]!;
    const withoutReceipt = events.map(e => e === late ? {
      ...late, payload: { ...late.payload, snapshot: { ...active, inputIds: ["second", "first"] } },
    } : e);
    expect(inspectLab(withoutReceipt, scenario, true).findings).toContainEqual(
      expect.objectContaining({ property: "input.durable-ack", eventId: events[ack]!.id }),
    );
  });

  it("attributes claims after restart to the latest source input, including after an older receipt was appended", () => {
    const { events, scenario } = trial([
      { kind: "delay-next", id: "late", tick: 0, channel: "input", delayTicks: 20 },
      order("first", "Tuesday", 1), order("second", "Thursday", 2),
      { kind: "crash", id: "down", tick: 30 }, { kind: "restart", id: "up", tick: 31 },
    ]);
    const boot = events.findIndex(e => e.kind === "agent.restarted");
    expect(boot).toBeGreaterThan(0);
    const wrong = { ...events.find(e => e.kind === "claim.emitted")!, id: "unsupported", payload: {
      epoch: 2, generation: 2, fragmentId: "unsupported", claim: { bookingId: "invented", day: "Tuesday" },
    } };
    const findings = inspectLab([...events.slice(0, boot + 1), wrong], scenario, false).findings;
    expect(findings.map(f => JSON.parse(f.signature)[1])).toEqual(["second", "second"]);
  });

  it("amends one booking on repeated changes, including a return to the original create day", () => {
    const { report, events } = trial([order("a", "Tuesday", 0), order("b", "Thursday", 12), order("c", "Tuesday", 24)]);
    expect(report.findings).toEqual([]);
    expect(events.filter(e => e.kind === "provider.committed").map(e => e.payload.day)).toEqual(["Tuesday", "Thursday", "Tuesday"]);
    expect(report.bookings).toEqual([{ bookingId: "booking-1", day: "Tuesday" }]);
  });

  it.each([["always-handoff", "progress.confirmed"], ["silent", "progress.confirmed"], ["premature-ack", "input.durable-ack"]])(
    "%s fails %s without consulting the policy identity", (policy, property) => {
      const { events, scenario } = trial([order("want", "Thursday", 0)], policy);
      const report = inspectLab(events, { ...scenario, policy: "safe" }, true);
      expect(report.findings.map(finding => finding.property)).toContain(property);
    },
  );

  it("detects a stale claim relabeled with the current generation", () => {
    const { report } = trial([order("first", "Tuesday", 0), order("second", "Thursday", 12)], "stale-fragment");
    expect(report.findings[0]?.property).toBe("claim.latest");
  });

  it("keeps a prefix safety failure and defers progress for an unfinished run", () => {
    const { events, scenario } = trial([order("want", "Thursday", 0)], "premature-ack");
    const before = events.findIndex(e => e.kind === "input.ackRequested");
    const clean = inspectLab(events.slice(0, before), scenario, false);
    expect(clean.verdict).toBe("inconclusive");
    expect(clean.findings).toEqual([]);
    const violated = inspectLab(events.slice(0, before + 1), scenario, false);
    expect(violated.verdict).toBe("fail");
    expect(violated.findings.map(f => f.property)).toEqual(["input.durable-ack"]);
  });

  it("treats an already sounding old generation as a remnant, and flags a new start after effective flush", () => {
    const { events, scenario } = trial([order("want", "Thursday", 0)]);
    const play = events.find(event => event.kind === "device.playbackStarted")!;
    const flush: LabEvent = { ...play, id: "flush", kind: "device.flushed", payload: { generation: 2 } };
    const remnant = { ...play, id: "remaining", kind: "device.remnant" };
    expect(inspectLab([...events, flush, remnant], scenario, true).findings).toEqual([]);
    const stale = { ...play, id: "stale-start" };
    const after = inspectLab([...events, flush, remnant, stale], scenario, true);
    expect(after.findings).toContainEqual(expect.objectContaining({ property: "playback.generation", eventId: stale.id }));
  });

  it("recognizes stale journal writes and a forged claim without a delivered receipt", () => {
    const { events, scenario } = trial([order("want", "Thursday", 0)]);
    const altered = events.map(e => e.kind === "store.committed" ? { ...e, payload: { ...e.payload, epoch: 0 } } : e)
      .filter(e => e.kind !== "reply.delivered");
    const properties = inspectLab(altered, scenario, true).findings.map(f => f.property);
    expect(properties).toContain("store.epoch");
    expect(properties).toContain("claim.supported");
  });

  it("rejects a real create performed before the caller requested its day, even when confirmation eventually matches", () => {
    const scenario = parseScenario({ schemaVersion: 1, id: "speculative-create", policy: "speculative", delivery: "once",
      provider: { idempotent: true, query: true, amend: true }, expectation: "confirmed", actions: [order("actual", "Thursday", 10)] });
    const agent: AgentAdapter<string | null> = {
      id: "speculative", version: "1", init: () => null,
      step(next, input) {
        switch (input.kind) {
          case "start": return { next, commands: [{ kind: "store", requestId: "save", expectedRevision: 0,
            snapshot: { createDay: "Thursday", createKey: "speculative-create" } }] };
          case "store-ack": return { next, commands: [{ kind: "provider", requestId: "try", operation: {
            kind: "create", key: "speculative-create", day: "Thursday",
          } }] };
          case "provider-reply": return { next: input.bookingId, commands: [] };
          case "input": if (next) return { next, commands: [{ kind: "speech", generation: 1, claim: { bookingId: next, day: input.day } }] };
        }
        return { next, commands: [] };
      },
    };
    const { events } = executeWorld(scenario, agent);
    const report = inspectLab(events, scenario, true);
    expect(events.findIndex(e => e.kind === "provider.committed")).toBeLessThan(events.findIndex(e => e.kind === "caller.spoke"));
    expect(report.played.map(mark => mark.day)).toEqual(["Thursday"]);
    expect(report.findings.map(({ property, eventId }) => [property, eventId])).toEqual([
      ["dispatch.intent", events.find(e => e.kind === "request.sent")?.id],
    ]);
  });

  it("permits the original durable Tuesday create retry after a Thursday correction, then amends the same booking", () => {
    const { events, report, scenario } = trial([
      { kind: "drop-next", id: "lost-receipt", tick: 0, channel: "providerReply" },
      order("original", "Tuesday", 0), order("correction", "Thursday", 6),
    ], "safe", { provider: { idempotent: true, query: false, amend: true } });
    const sends = events.filter(e => e.kind === "request.sent");
    expect(sends.map(e => e.payload.operation)).toEqual([
      { kind: "create", key: "booking.create.1", day: "Tuesday" },
      { kind: "create", key: "booking.create.1", day: "Tuesday" },
      { kind: "amend", key: "booking.amend.2", day: "Thursday", bookingId: "booking-1" },
    ]);
    expect(report.findings).toEqual([]);
    const wrong = events.map(e => e !== sends[2] ? e : { ...e, payload: { ...e.payload, operation: {
      kind: "amend", key: "booking.amend.2", day: "Thursday", bookingId: "unrelated",
    } } });
    expect(inspectLab(wrong, scenario, true).findings).toContainEqual(
      expect.objectContaining({ property: "dispatch.booking", eventId: sends[2]!.id }),
    );
    const hiddenIdentity = events.filter(e => e.kind !== "reply.delivered" || e.payload.requestId !== sends[1]!.payload.requestId);
    expect(inspectLab(hiddenIdentity, scenario, true).findings).toContainEqual(
      expect.objectContaining({ property: "dispatch.booking", eventId: sends[2]!.id }),
    );
  });

  it("asks for reconfirmation in two one-shot histories with the same recovered snapshot", () => {
    const cut = [{ id: "crash", kind: "crash", tick: 14 }, { id: "restart", kind: "restart", tick: 15, parents: ["crash"] }];
    const extra = [{ id: "slow", kind: "delay-next", tick: 10, channel: "store", delayTicks: 10 }, order("lost", "Thursday", 11)];
    const branches = [[], extra].map(perturb => trial([order("first", "Tuesday", 0), ...perturb, ...cut], "safe",
      { delivery: "once", expectation: "reconfirm" }));
    expect(branches[0]!.report.latestIntent?.day).toBe("Tuesday");
    expect(branches[1]!.report.latestIntent?.day).toBe("Thursday");
    expect(branches.map(b => b.events.find(e => e.kind === "agent.restarted")?.payload.snapshot)).toEqual([
      expect.objectContaining({ inputIds: ["first"] }), expect.objectContaining({ inputIds: ["first"] }),
    ]);
    for (const { report } of branches) {
      expect(report.findings).toEqual([]);
      expect(report.reconfirm?.reason).toContain("reconfirm");
    }
  });
});
