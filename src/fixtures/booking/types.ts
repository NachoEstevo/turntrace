export const bookingScenario = Object.freeze({
  id: "booking-correction",
  bookingId: "booking-1",
  initialDay: "Tuesday",
  correctedDay: "Thursday",
} as const);

export type Day = typeof bookingScenario.initialDay | typeof bookingScenario.correctedDay;
export type Order = "correction-first" | "commit-first";
export type Policy = "buggy" | "fixed";
export type Booking = { bookingId: string; day: Day };
export type Operation = "create" | "revise-pending" | "amend";
export type Request = Booking & { operation: Operation };
export type RevisionOutcome = "pending-revised" | "too-late";
export type Commit = Booking & { operation: "create" | "amend" };
export type Reply =
  | (Commit & { outcome: "committed" })
  // A revision receipt echoes the requested day, including on rejection.
  | (Booking & { operation: "revise-pending"; outcome: RevisionOutcome });
export type Claim = Booking & { claimId: string };

type Fact<Actor extends string, Kind extends string, Payload> = {
  actor: Actor;
  kind: Kind;
  payload: Payload;
};

export type BookingFact =
  | Fact<"agent", "input.delivered", { day: Day }>
  | Fact<"agent", "request.sent", Request>
  | Fact<"provider", "provider.pending", Booking>
  | Fact<"provider", "provider.revision", Booking & { outcome: RevisionOutcome }>
  | Fact<"provider", "provider.committed", Commit>
  | Fact<"agent", "reply.delivered", Reply>
  | Fact<"agent", "claim.emitted", Claim>
  | Fact<"device", "device.queued", Claim>
  | Fact<"device", "device.playbackStarted", Claim>;

export type BookingEvent = BookingFact & {
  id: string;
  tick: number;
  parents: readonly string[];
};
