import type { BookingOperation, Day, ProviderCapabilities, ProviderReply } from "./contract.js";

type Mutation = Exclude<BookingOperation, { kind: "query" }>;
type ActiveBooking = { bookingId: string; createKey: string; day: Day };
type Receipt = { operation: Mutation; bookingId: string; day: Day };

export type ProviderExecution = {
  effect: "created" | "amended" | "reused" | "queried" | "rejected";
  reply: ProviderReply;
};

function sameMutation(original: Mutation, retried: Mutation): boolean {
  if (original.day !== retried.day) return false;
  if (original.kind === "create") return retried.kind === "create";
  return retried.kind === "amend" && original.bookingId === retried.bookingId;
}

/** Current reservations and historical receipts survive agent restarts. */
export class WorldProvider {
  private readonly capabilities: ProviderCapabilities;
  private readonly bookings = new Map<string, ActiveBooking>();
  private readonly receipts = new Map<string, Receipt>();

  constructor(capabilities: ProviderCapabilities) {
    this.capabilities = { ...capabilities };
  }

  activeBookings(): ActiveBooking[] {
    return Array.from(this.bookings.values(), booking => ({ ...booking }));
  }

  execute(requestId: string, operation: BookingOperation, failBeforeCommit = false): ProviderExecution {
    // Each reply belongs to this transport request, including a cached result.
    const envelope = { kind: "provider-reply" as const, requestId, operation: { ...operation } };
    const reject = (reason: string, failure?: "precommit"): ProviderExecution => ({
      effect: "rejected", reply: { ...envelope, outcome: "rejected", bookingId: null, day: null, reason,
        ...(failure ? { failure } : {}) },
    });

    if (operation.kind === "query") {
      if (!this.capabilities.query) return reject("The provider does not support lookup.");
      const matches = [...this.bookings.values()].filter(booking => booking.createKey === operation.key);
      if (matches.length > 1) return reject("Multiple reservations match this create key.");
      const booking = matches[0];
      return {
        effect: "queried",
        reply: {
          ...envelope, outcome: booking ? "found" : "missing",
          bookingId: booking?.bookingId ?? null, day: booking?.day ?? null,
        },
      };
    }

    if (operation.kind === "amend" && !this.capabilities.amend) {
      return reject("The provider does not support amendments.");
    }
    const saved = this.receipts.get(operation.key);
    if (saved) {
      if (!sameMutation(saved.operation, operation)) return reject("Idempotency key conflicts with an earlier operation.");
      return {
        effect: "reused",
        reply: { ...envelope, outcome: "committed", bookingId: saved.bookingId, day: saved.day },
      };
    }
    if (failBeforeCommit) return reject("The provider failed before commitment.", "precommit");

    let booking: ActiveBooking;
    if (operation.kind === "create") {
      booking = { bookingId: `booking-${this.bookings.size + 1}`, createKey: operation.key, day: operation.day };
    } else {
      const existing = this.bookings.get(operation.bookingId);
      if (!existing) return reject("No reservation exists for this amendment.");
      booking = { ...existing, day: operation.day };
    }
    this.bookings.set(booking.bookingId, booking);
    if (this.capabilities.idempotent) {
      this.receipts.set(operation.key, { operation: { ...operation }, bookingId: booking.bookingId, day: booking.day });
    }
    return {
      effect: operation.kind === "create" ? "created" : "amended",
      reply: { ...envelope, outcome: "committed", bookingId: booking.bookingId, day: booking.day },
    };
  }
}
