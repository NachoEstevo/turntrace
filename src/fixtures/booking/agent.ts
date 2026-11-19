import type { Claim, Day, Policy, Reply, Request } from "./types.js";

export type AgentCommand = { kind: "request"; request: Request } | { kind: "confirm"; claim: Claim };

export class BookingAgent {
  private wanted?: Day;

  constructor(private readonly policy: Policy, private readonly bookingId: string) {}

  receiveInput(day: Day): AgentCommand {
    const operation = this.wanted === undefined ? "create" : "revise-pending";
    this.wanted = day;
    return { kind: "request", request: { operation, bookingId: this.bookingId, day } };
  }

  receiveReply(reply: Reply): AgentCommand | undefined {
    if (this.wanted === undefined || reply.bookingId !== this.bookingId) return;
    if (reply.outcome === "too-late" && this.policy === "fixed") {
      return { kind: "request", request: { operation: "amend", bookingId: this.bookingId, day: this.wanted } };
    }
    // The bug mistakes a rejected pending revision for a completed amendment.
    const confirms = reply.outcome === "committed" || (this.policy === "buggy" && reply.outcome === "too-late");
    if (confirms && reply.day === this.wanted) {
      return { kind: "confirm", claim: { claimId: "confirmation-1", bookingId: this.bookingId, day: this.wanted } };
    }
  }
}
