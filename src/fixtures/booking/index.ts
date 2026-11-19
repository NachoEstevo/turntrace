import { Scheduler } from "../../core/scheduler.js";
import { BookingAgent, type AgentCommand } from "./agent.js";
import { BookingProvider } from "./provider.js";
import { bookingScenario } from "./types.js";
import type { Booking, BookingEvent, BookingFact, Claim, Commit, Day, Order, Policy, Reply, Request } from "./types.js";

export { bookingScenario };
export type { BookingEvent, Day, Order, Policy } from "./types.js";

const suffix = { create: "create", "revise-pending": "revise", amend: "amend" } as const;
const priorities: Record<Order, readonly string[]> = {
  "correction-first": ["input.thursday", "request.revise", "provider.revise", "provider.commit"],
  "commit-first": ["provider.commit", "input.thursday", "request.revise", "provider.revise"],
};

export function runBooking(policy: Policy, order: Order, replayChoices?: readonly string[]): {
  choices: readonly string[];
  events: readonly BookingEvent[];
} {
  const scheduler = new Scheduler();
  const agent = new BookingAgent(policy, bookingScenario.bookingId);
  const provider = new BookingProvider();
  const playbackQueue: Claim[] = [];
  const events: BookingEvent[] = [];

  // The scheduler owns the enabling edges. A provider observation can also
  // cite the last state transition it actually read on this particular path.
  type Observe = (fact: BookingFact, readFrom?: string) => void;
  function at(id: string, tick: number, parents: string[], step: (observe: Observe) => void): void {
    scheduler.schedule({
      id, tick, parents,
      run() {
        step((fact, readFrom) => {
          const causes = readFrom && !parents.includes(readFrom) ? [...parents, readFrom] : parents;
          // Capture payloads before another actor can change them.
          events.push(structuredClone({ id, tick, parents: causes, ...fact }));
        });
      },
    });
  }

  function dispatch(command: AgentCommand | undefined, tick: number, parent: string): void {
    if (!command) return;
    if (command.kind === "request") send(command.request, tick, parent);
    else speak(command.claim, tick, parent);
  }

  function deliverInput(id: string, tick: number, parents: string[], day: Day): void {
    at(id, tick, parents, observe => {
      observe({ actor: "agent", kind: "input.delivered", payload: { day } });
      dispatch(agent.receiveInput(day), tick, id);
    });
  }

  function deliverReply(reply: Reply, tick: number, parent: string): void {
    const id = `reply.${suffix[reply.operation]}`;
    at(id, tick, [parent], observe => {
      observe({ actor: "agent", kind: "reply.delivered", payload: reply });
      dispatch(agent.receiveReply(reply), tick, id);
    });
  }

  function send(request: Request, tick: number, parent: string): void {
    const id = `request.${suffix[request.operation]}`;
    at(id, tick, [parent], observe => {
      observe({ actor: "agent", kind: "request.sent", payload: request });
      const booking: Booking = { bookingId: request.bookingId, day: request.day };
      switch (request.operation) {
        case "create":
          open(booking, tick + 1, id);
          break;
        case "revise-pending":
          revise(booking, tick, id);
          break;
        case "amend":
          amend(booking, tick, id);
          break;
      }
    });
  }

  function open(booking: Booking, tick: number, parent: string): void {
    at("provider.pending", tick, [parent], observe => {
      provider.open(booking, "provider.pending");
      observe({ actor: "provider", kind: "provider.pending", payload: booking });
      at("provider.commit", tick + 1, ["provider.pending"], record => {
        const result = provider.commit(booking.bookingId, "provider.commit");
        const commit: Commit = { ...result.booking, operation: "create" };
        record({ actor: "provider", kind: "provider.committed", payload: commit }, result.previous);
        deliverReply({ ...commit, outcome: "committed" }, tick + 2, "provider.commit");
      });
    });
  }

  function revise(booking: Booking, tick: number, parent: string): void {
    at("provider.revise", tick, [parent], observe => {
      const { outcome, previous } = provider.revisePending(booking, "provider.revise");
      observe({ actor: "provider", kind: "provider.revision", payload: { ...booking, outcome } }, previous);
      deliverReply({ ...booking, operation: "revise-pending", outcome }, tick + 2, "provider.revise");
    });
  }

  function amend(booking: Booking, tick: number, parent: string): void {
    at("provider.amend", tick, [parent], observe => {
      const previous = provider.amend(booking, "provider.amend");
      const commit: Commit = { ...booking, operation: "amend" };
      observe({ actor: "provider", kind: "provider.committed", payload: commit }, previous);
      deliverReply({ ...commit, outcome: "committed" }, tick + 1, "provider.amend");
    });
  }

  function speak(claim: Claim, tick: number, parent: string): void {
    at("agent.confirm", tick, [parent], observe => {
      observe({ actor: "agent", kind: "claim.emitted", payload: claim });
      at("device.queue", tick + 1, ["agent.confirm"], enqueue => {
        playbackQueue.push(claim);
        enqueue({ actor: "device", kind: "device.queued", payload: claim });
        at("device.play", tick + 2, ["device.queue"], play => {
          const queued = playbackQueue.shift();
          if (!queued) throw new Error("Playback requires a queued confirmation.");
          play({ actor: "device", kind: "device.playbackStarted", payload: queued });
        });
      });
    });
  }

  deliverInput("input.tuesday", 0, [], bookingScenario.initialDay);
  deliverInput("input.thursday", 2, ["input.tuesday"], bookingScenario.correctedDay);
  const choices = scheduler.run(priorities[order], replayChoices);
  return { choices, events };
}
