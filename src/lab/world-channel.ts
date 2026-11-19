import type { Channel, Scenario } from "./contract.js";

type Fault = { id: string; kind: "drop-next" | "duplicate-next" | "delay-next"; delayTicks?: number };
type Release = { id: string; tick: number; parents: string[]; dropped: boolean; duplicate: boolean };

function checkedTick(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("A channel tick must be a nonnegative safe integer.");
  return value;
}

export class WorldChannels {
  private readonly delays: Scenario["delays"];
  private readonly fifo: Set<Channel>;
  private readonly faults = new Map<Channel, Fault[]>();
  private readonly tails = new Map<string, { id: string; tick: number }>();

  constructor(scenario: Pick<Scenario, "delays" | "fifo">) {
    this.delays = { ...scenario.delays };
    this.fifo = new Set(scenario.fifo);
  }

  arm(channel: Channel, fault: Fault): void {
    if (fault.kind === "delay-next") checkedTick(fault.delayTicks ?? NaN);
    const queue = this.faults.get(channel) ?? [];
    queue.push({ ...fault });
    this.faults.set(channel, queue);
  }

  plan(channel: Channel, sender: string, tick: number, makeId: (copy: number) => string): Release[] {
    const queue = this.faults.get(channel) ?? [];
    // Different fault kinds can combine on a send. Repeated faults of one kind
    // target consecutive sends. Dropping a send suppresses both copies.
    const selected = new Map<Fault["kind"], Fault>();
    for (const fault of queue) {
      if (!selected.has(fault.kind)) selected.set(fault.kind, fault);
    }
    const extra = selected.get("delay-next")?.delayTicks ?? 0;
    const earliest = checkedTick(checkedTick(tick) + checkedTick(this.delays[channel]) + extra);
    const stream = `${channel}:${sender}`;
    let previous = this.tails.get(stream);
    const releaseTick = Math.max(earliest, previous?.tick ?? 0);
    const dropped = selected.has("drop-next");
    const copies = !dropped && selected.has("duplicate-next") ? 2 : 1;
    const releases: Release[] = [];
    for (let copy = 0; copy < copies; copy++) {
      const parents = Array.from(selected.values(), fault => fault.id);
      if (previous) parents.push(previous.id);
      const id = makeId(copy);
      releases.push({ id, tick: releaseTick, parents, dropped, duplicate: copy !== 0 });
      if (this.fifo.has(channel)) previous = { id, tick: releaseTick };
    }
    if (previous) this.tails.set(stream, previous);
    this.faults.set(channel, queue.filter(fault => selected.get(fault.kind) !== fault));
    return releases;
  }
}
