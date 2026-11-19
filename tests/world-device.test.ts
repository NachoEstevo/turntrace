import { describe, expect, it } from "vitest";
import { WorldDevice, type Fragment } from "../src/lab/world-device.js";

function fragment(generation: number): Fragment {
  return { epoch: 1, generation, fragmentId: `claim-${generation}`, claim: { bookingId: "booking-1", day: "Thursday" } };
}

describe("playback device", () => {
  it("queues separate copies of one fragment and allows one playback at a time", () => {
    const device = new WorldDevice();
    const first = device.accept(fragment(1))!;
    const second = device.accept(fragment(1))!;
    expect(first).not.toBe(second);
    expect(device.ready(first)).toBe(true);
    expect(device.ready(second)).toBe(false);
    expect(device.start(second)).toBeNull();
    expect(device.start(first)).toEqual(fragment(1));
    device.finish(second);
    expect(device.ready(second)).toBe(false);
    device.finish(first);
    expect(device.ready(second)).toBe(true);
    expect(device.start(second)).toEqual(fragment(1));
    expect(device.start(first)).toBeNull();
  });

  it("drops old queued and late fragments while a playing remnant continues to its matching finish", () => {
    const device = new WorldDevice();
    const playing = device.accept(fragment(1))!;
    const stale = device.accept(fragment(1))!;
    const newest = device.accept(fragment(2))!;
    device.start(playing);
    expect(device.flush(2)).toEqual({ floor: 2, remnant: fragment(1) });
    expect(device.ready(stale)).toBe(true);
    expect(device.start(stale)).toBeNull();
    expect(device.accept(fragment(1))).toBeNull();
    expect(device.flush(0)).toEqual({ floor: 2, remnant: fragment(1) });
    device.drop(playing);
    device.finish(stale);
    expect(device.ready(newest)).toBe(false);
    device.finish(playing);
    expect(device.start(newest)).toEqual(fragment(2));
    expect(device.flush(2)).toEqual({ floor: 2, remnant: null });
  });

  it("drains a dropped ticket and admits the next queued fragment", () => {
    const device = new WorldDevice();
    const dropped = device.accept(fragment(1))!;
    const kept = device.accept(fragment(2))!;
    device.drop(dropped);
    expect(device.ready(dropped)).toBe(true);
    expect(device.start(dropped)).toBeNull();
    expect(device.start(kept)).toEqual(fragment(2));
  });

  it("keeps admission, playback and flush observations isolated from later mutations", () => {
    const device = new WorldDevice();
    const input = fragment(1);
    const ticket = device.accept(input)!;
    input.generation = 5;
    input.claim.day = "Tuesday";
    const playing = device.start(ticket)!;
    expect(playing).toEqual(fragment(1));
    playing.claim.bookingId = "edited";
    const cut = device.flush(2);
    expect(cut.remnant).toEqual(fragment(1));
    cut.remnant!.claim.day = "Tuesday";
    expect(device.flush(2).remnant).toEqual(fragment(1));
  });
});
