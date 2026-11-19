import { describe, expect, it } from "vitest";
import { WorldChannels } from "../src/lab/world-channel.js";

const delays = { input: 1, inputAck: 1, store: 1, storeAck: 1, provider: 1, providerReply: 1, speech: 1, playback: 1, flush: 1 };
const id = (name: string) => (copy: number) => `${name}.${copy}`;

describe("world channels", () => {
  it("consumes at most one fault of each kind per send on the named channel", () => {
    const channels = new WorldChannels({ delays, fifo: [] });
    channels.arm("provider", { id: "lost-first", kind: "drop-next" });
    channels.arm("provider", { id: "lost-second", kind: "drop-next" });
    channels.arm("provider", { id: "extra-copy", kind: "duplicate-next" });
    channels.arm("provider", { id: "slow", kind: "delay-next", delayTicks: 4 });
    expect(channels.plan("speech", "agent", 0, id("speech"))[0]?.parents).toEqual([]);
    expect(channels.plan("provider", "agent", 1, id("one"))).toEqual([
      { id: "one.0", tick: 6, parents: ["lost-first", "extra-copy", "slow"], dropped: true, duplicate: false },
    ]);
    expect(channels.plan("provider", "agent", 2, id("two"))).toEqual([
      { id: "two.0", tick: 3, parents: ["lost-second"], dropped: true, duplicate: false },
    ]);
    expect(channels.plan("provider", "agent", 3, id("three"))).toEqual([
      { id: "three.0", tick: 4, parents: [], dropped: false, duplicate: false },
    ]);
  });

  it("orders both FIFO copies, the next packet and its release tick within one sender and channel", () => {
    const channels = new WorldChannels({ delays, fifo: ["provider", "store"] });
    channels.arm("provider", { id: "slow", kind: "delay-next", delayTicks: 7 });
    channels.arm("provider", { id: "copied", kind: "duplicate-next" });
    expect(channels.plan("provider", "old", 0, id("one"))).toEqual([
      { id: "one.0", tick: 8, parents: ["slow", "copied"], dropped: false, duplicate: false },
      { id: "one.1", tick: 8, parents: ["slow", "copied", "one.0"], dropped: false, duplicate: true },
    ]);
    expect(channels.plan("provider", "new", 1, id("two"))[0]).toMatchObject({ tick: 2, parents: [] });
    expect(channels.plan("store", "old", 1, id("three"))[0]).toMatchObject({ tick: 2, parents: [] });
    expect(channels.plan("provider", "old", 1, id("four"))[0]).toMatchObject({ tick: 8, parents: ["one.1"] });
  });

  it("leaves unordered duplicates independent and allows a later send to release first", () => {
    const channels = new WorldChannels({ delays, fifo: [] });
    channels.arm("input", { id: "copied", kind: "duplicate-next" });
    channels.arm("input", { id: "slow", kind: "delay-next", delayTicks: 5 });
    const first = channels.plan("input", "caller", 0, id("one"));
    expect(first.map(packet => [packet.tick, packet.duplicate, packet.parents])).toEqual([
      [6, false, ["copied", "slow"]], [6, true, ["copied", "slow"]],
    ]);
    expect(channels.plan("input", "caller", 1, id("two"))[0]).toMatchObject({ tick: 2, parents: [] });
  });

  it("rejects invalid virtual ticks without consuming the next packet's fault", () => {
    const channels = new WorldChannels({ delays, fifo: [] });
    expect(() => channels.arm("input", { id: "invalid", kind: "delay-next", delayTicks: -1 })).toThrow(/safe integer/);
    channels.arm("input", { id: "later", kind: "delay-next", delayTicks: 1 });
    expect(() => channels.plan("input", "caller", Number.MAX_SAFE_INTEGER - 1, id("overflow"))).toThrow(/safe integer/);
    expect(() => channels.plan("input", "caller", 0.5, id("fractional"))).toThrow(/safe integer/);
    expect(channels.plan("input", "caller", Number.MAX_SAFE_INTEGER - 2, id("last"))[0]).toMatchObject({
      tick: Number.MAX_SAFE_INTEGER, parents: ["later"],
    });
  });
});
