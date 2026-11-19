import { describe, expect, it } from "vitest";
import { inspectBooking } from "../src/checks/booking.js";
import { runBooking } from "../src/fixtures/booking/index.js";

describe("booking observations", () => {
  it("locates the first unsupported claim and includes three independent accounts", () => {
    const { events } = runBooking("buggy", "commit-first");
    const report = inspectBooking(events);
    expect(report.verdict).toBe("fail");
    expect(report.findings.map(({ property, eventId }) => [property, eventId])).toEqual([
      ["claim.supported", "agent.confirm"],
      ["playback.booked", "device.play"],
      ["booking.latest", "provider.commit"],
    ]);
    expect(report.latestRequest).toBe("Thursday");
    expect(report.agent.received.some(({ detail }) => detail.includes("too-late"))).toBe(true);
    expect(report.agent.said[0]?.detail).toContain("Thursday");
    expect(report.device.queued[0]?.eventId).toBe("device.queue");
    expect(report.device.played[0]?.eventId).toBe("device.play");
    expect(report.provider.active.map(({ day }) => day)).toEqual(["Tuesday"]);
  });

  it.each([
    ["buggy", "correction-first"],
    ["fixed", "correction-first"],
    ["fixed", "commit-first"],
  ] as const)("%s confirms a committed Thursday booking in %s", (policy, order) => {
    const { events } = runBooking(policy, order);
    const report = inspectBooking(events);
    expect(report.findings).toEqual([]);
    expect(report.verdict).toBe("pass");
    expect(report.provider.active.map(({ day }) => day)).toEqual(["Thursday"]);
    expect(report.provider.history).toHaveLength(order === "commit-first" ? 2 : 1);
    expect(report.device.played.map(({ eventId }) => eventId)).toEqual(["device.play"]);
  });

  it("does not credit a commitment delivered after the agent's claim", () => {
    const { events } = runBooking("fixed", "commit-first");
    const delivered = events.filter((event) => event.id === "reply.amend");
    expect(delivered).toHaveLength(1);
    const report = inspectBooking([...events.filter((event) => event.id !== "reply.amend"), ...delivered]);
    expect(report.findings.map(({ property }) => property)).toEqual(["claim.supported"]);
  });

  it("identifies playback without queueing and a queue that never played", () => {
    const { events } = runBooking("fixed", "correction-first");
    const unqueued = inspectBooking(events.filter((event) => event.kind !== "device.queued"));
    expect(unqueued.findings.map(({ property }) => property)).toEqual(["playback.queued"]);
    const silent = inspectBooking(events.filter((event) => event.kind !== "device.playbackStarted"));
    expect(silent.findings.map(({ property }) => property)).toEqual(["playback.latest"]);
  });

  it("reports a second booking even when the last request and confirmation agree", () => {
    const { events } = runBooking("fixed", "correction-first");
    const created = events.find((event) => event.kind === "provider.committed");
    if (!created || created.kind !== "provider.committed") throw new Error("Missing fixture commitment.");
    const duplicate = {
      ...created, id: "provider.duplicate", payload: { ...created.payload, bookingId: "extra-booking" },
    };
    const report = inspectBooking([...events, duplicate]);
    expect(report.provider.active).toHaveLength(2);
    expect(report.findings).toMatchObject([{ property: "booking.unique", eventId: duplicate.id }]);
  });
});
