import { describe, expect, it } from "vitest";
import { inspectRecovery } from "../src/checks/recovery.js";
import { runRecovery, type RecoveryEvent } from "../src/fixtures/recovery/index.js";

function fact<K extends RecoveryEvent["kind"]>(events: readonly RecoveryEvent[], kind: K) {
  const event = events.find((entry): entry is Extract<RecoveryEvent, { kind: K }> => entry.kind === kind);
  if (!event) throw new Error(`Missing fixture event ${kind}`);
  return event;
}

describe("independent recovery observations", () => {
  it("attributes the recovered confirmation to the second attempt's delivered result", () => {
    const { events } = runRecovery("safe", "idempotent");
    const report = inspectRecovery(events, "idempotent");
    expect(report.findings).toEqual([]);
    expect(report.verdict).toBe("pass");
    expect(report.status).toBe("confirmed");
    expect(report.bookings).toEqual([{ bookingId: "booking-1", day: "Thursday" }]);
    expect(report.confirmation).toMatchObject({ bookingId: "booking-1", evidenceEventId: "reply.2" });
    expect(report.played).toEqual([{ eventId: "device.play", bookingId: "booking-1", day: "Thursday" }]);
    expect(report.review).toBeNull();
  });

  it("records one provider booking and an explicit unknown handoff with no playback", () => {
    const { events } = runRecovery("safe", "opaque");
    const report = inspectRecovery(events, "opaque");
    expect(report.findings).toEqual([]);
    expect(report.status).toBe("unknown");
    expect(report.review?.reason.trim().length).toBeGreaterThan(0);
    expect(report.bookings).toEqual([{ bookingId: "booking-1", day: "Thursday" }]);
    expect(report.confirmation).toBeNull();
    expect(report.played).toEqual([]);
  });

  it.each([["idempotent", "retry.key"], ["opaque", "retry.opaque"]] as const)(
    "pins the %s blind retry to the outgoing decision and the duplicate commit", (mode, property) => {
      const report = inspectRecovery(runRecovery("blind-retry", mode).events, mode);
      expect(report.verdict).toBe("fail");
      expect(report.findings[0]).toMatchObject({ property, eventId: "request.2" });
      expect(report.findings).toContainEqual(expect.objectContaining({ property: "booking.unique", eventId: "provider.2" }));
      expect(report.bookings.map(booking => booking.bookingId)).toEqual(["booking-1", "booking-2"]);
    },
  );

  it("requires a durable matching snapshot before first send and at restart", () => {
    const { events } = runRecovery("safe", "opaque");
    const noCommit = inspectRecovery(events.filter(event => event.kind !== "store.committed"), "opaque");
    expect(noCommit.findings).toContainEqual(expect.objectContaining({ property: "request.durable", eventId: "request.1" }));
    const wrongKey = inspectRecovery(events.map(event => event.kind === "agent.restarted"
      ? { ...event, payload: { ...event.payload, operationKey: "different" } } : event), "opaque");
    expect(wrongKey.findings).toContainEqual(expect.objectContaining({ property: "recovery.snapshot" }));
  });

  it("rejects delivery of the lost first reply on either side of its drop", () => {
    const { events } = runRecovery("safe", "opaque");
    const drop = fact(events, "reply.dropped");
    const delivery: RecoveryEvent = { ...drop, actor: "agent", kind: "reply.delivered", id: "delivery.old" };
    const beforeDrop = events.flatMap(event => event.id === drop.id ? [delivery, event] : [event]);
    expect(inspectRecovery(beforeDrop, "opaque").findings).toContainEqual(
      expect.objectContaining({ property: "reply.disposition", eventId: drop.id }),
    );
    const afterRestart = events.flatMap<RecoveryEvent>(event => event.kind === "agent.restarted" ? [event, delivery] : [event]);
    expect(inspectRecovery(afterRestart, "opaque").findings).toContainEqual(
      expect.objectContaining({ property: "reply.instance", eventId: delivery.id }),
    );
  });

  it("rejects a categorical claim based only on the lab's provider record", () => {
    const opaque = runRecovery("safe", "opaque").events;
    const claim = fact(runRecovery("safe", "idempotent").events, "claim.emitted");
    const report = inspectRecovery([...opaque, claim], "opaque");
    expect(report.confirmation?.evidenceEventId).toBeNull();
    expect(report.findings).toContainEqual(expect.objectContaining({ property: "claim.supported", eventId: claim.id }));
    expect(report.findings).toContainEqual(expect.objectContaining({ property: "recovery.unknown" }));
  });

  it("does not count playback from the crashed epoch as recovery progress", () => {
    const { events } = runRecovery("safe", "idempotent");
    const old = events.filter(event => event.kind === "device.queued" || event.kind === "device.playbackStarted")
      .map(event => ({ ...event, payload: { ...event.payload, epoch: 1 } }));
    const noNewPlayback = events.filter(event => event.kind !== "device.queued" && event.kind !== "device.playbackStarted");
    const modified = noNewPlayback.flatMap<RecoveryEvent>(event => event.kind === "agent.crashed" ? [...old, event] : [event]);
    expect(inspectRecovery(modified, "idempotent").findings).toContainEqual(
      expect.objectContaining({ property: "recovery.confirmed" }),
    );
  });

  it("requires progress under each provider contract", () => {
    const { events } = runRecovery("safe", "opaque");
    expect(inspectRecovery(events, "idempotent").findings).toContainEqual(
      expect.objectContaining({ property: "recovery.confirmed" }),
    );
    const noHandoff = events.filter(event => event.kind !== "agent.reviewRequested");
    expect(inspectRecovery(noHandoff, "opaque").findings).toContainEqual(
      expect.objectContaining({ property: "recovery.unknown" }),
    );
  });
});
