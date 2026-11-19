import { describe, expect, it } from "vitest";
import { runBooking, type Order } from "../src/fixtures/booking/index.js";

describe("booking fixture causality", () => {
  it("captures separate snapshots of the emitted, queued and played claim", () => {
    const { events } = runBooking("fixed", "commit-first");
    const playback = events.find(event => event.kind === "device.playbackStarted")!;
    playback.payload.day = "Tuesday";
    expect(events.find(event => event.kind === "claim.emitted")?.payload.day).toBe("Thursday");
    expect(events.find(event => event.kind === "device.queued")?.payload.day).toBe("Thursday");
  });

  it.each([
    ["correction-first", ["input.thursday", "request.revise", "provider.revise", "provider.commit"]],
    ["commit-first", ["provider.commit", "input.thursday", "request.revise", "provider.revise"]],
  ] as const)("resolves the shared tick in %s order", (order, expected) => {
    const { choices, events } = runBooking("fixed", order);
    expect(events.filter(event => event.tick === 2).map(event => event.id)).toEqual(expected);
    expect(choices).toEqual(events.map(event => event.id));
    const observed = new Set<string>();
    for (const event of events) {
      for (const cause of event.parents) expect(observed.has(cause)).toBe(true);
      observed.add(event.id);
    }
  });

  it.each([
    ["correction-first", "provider.commit", "provider.revise"],
    ["commit-first", "provider.revise", "provider.commit"],
  ] satisfies [Order, string, string][])("records which provider change was observed in %s", (order, event, cause) => {
    const { events } = runBooking("fixed", order);
    expect(events.find(observation => observation.id === event)?.parents).toContain(cause);
  });

  it("delivering the correction alone cannot change a pending booking", () => {
    // Exercise a legal interleaving between the two named demonstration schedules.
    const { choices } = runBooking("fixed", "commit-first");
    const interleaved = [...choices];
    const commit = interleaved.indexOf("provider.commit");
    interleaved.splice(commit, 2, "input.thursday", "provider.commit");
    const { events } = runBooking("fixed", "commit-first", interleaved);
    expect(events.find(event => event.id === "provider.commit")?.payload).toMatchObject({ day: "Tuesday" });
    expect(events.find(event => event.id === "reply.revise")?.payload).toMatchObject({ outcome: "too-late" });
    expect(events.find(event => event.id === "provider.amend")?.payload).toMatchObject({ day: "Thursday" });
  });
});
