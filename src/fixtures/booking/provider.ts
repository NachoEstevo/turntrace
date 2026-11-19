import type { Booking, RevisionOutcome } from "./types.js";

// The provider owns the booking, including which event last changed it.
type Record = Booking & { phase: "pending" | "committed"; changedBy: string };

export class BookingProvider {
  private record?: Record;

  open(booking: Booking, eventId: string): void {
    if (this.record) throw new Error("A booking already exists in this fixture.");
    this.record = { ...booking, phase: "pending", changedBy: eventId };
  }

  revisePending(booking: Booking, eventId: string): { outcome: RevisionOutcome; previous: string } {
    const current = this.lookup(booking.bookingId);
    if (current.phase === "committed") return { outcome: "too-late", previous: current.changedBy };
    this.record = { ...booking, phase: "pending", changedBy: eventId };
    return { outcome: "pending-revised", previous: current.changedBy };
  }

  commit(bookingId: string, eventId: string): { booking: Booking; previous: string } {
    const current = this.lookup(bookingId);
    if (current.phase !== "pending") throw new Error("The create request has already committed.");
    this.record = { ...current, phase: "committed", changedBy: eventId };
    return { booking: { bookingId, day: current.day }, previous: current.changedBy };
  }

  amend(booking: Booking, eventId: string): string {
    const current = this.lookup(booking.bookingId);
    if (current.phase !== "committed") throw new Error("Amend requires a committed booking.");
    this.record = { ...booking, phase: "committed", changedBy: eventId };
    return current.changedBy;
  }

  private lookup(bookingId: string): Record {
    if (this.record?.bookingId !== bookingId) throw new Error(`Unknown booking ${bookingId}.`);
    return this.record;
  }
}
