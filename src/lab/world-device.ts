import type { Day } from "./contract.js";

export type Fragment = {
  epoch: number;
  generation: number;
  claim: { bookingId: string; day: Day };
  fragmentId: string;
};
export type Ticket = number;

function copy(fragment: Fragment): Fragment {
  return { ...fragment, claim: { ...fragment.claim } };
}

export class WorldDevice {
  private floor = 0;
  private nextTicket = 1;
  private readonly queue = new Map<Ticket, Fragment>();
  private playing: { ticket: Ticket; fragment: Fragment } | null = null;

  accept(fragment: Fragment): Ticket | null {
    if (fragment.generation < this.floor) return null;
    const ticket = this.nextTicket++;
    this.queue.set(ticket, copy(fragment));
    return ticket;
  }

  ready(ticket: Ticket): boolean {
    // Invalidated tickets can drain their scheduled delivery as a skipped start.
    if (!this.queue.has(ticket)) return this.playing?.ticket !== ticket;
    return this.playing === null && this.queue.keys().next().value === ticket;
  }

  drop(ticket: Ticket): void {
    this.queue.delete(ticket);
  }

  start(ticket: Ticket): Fragment | null {
    const fragment = this.queue.get(ticket);
    if (!fragment || !this.ready(ticket)) return null;
    this.queue.delete(ticket);
    this.playing = { ticket, fragment };
    return copy(fragment);
  }

  finish(ticket: Ticket): void {
    if (this.playing?.ticket === ticket) this.playing = null;
  }

  flush(generation: number): { floor: number; remnant: Fragment | null } {
    this.floor = Math.max(this.floor, generation);
    for (const [ticket, fragment] of this.queue) {
      if (fragment.generation < this.floor) this.queue.delete(ticket);
    }
    const current = this.playing?.fragment;
    const remnant = current && current.generation < this.floor ? copy(current) : null;
    return { floor: this.floor, remnant };
  }
}
