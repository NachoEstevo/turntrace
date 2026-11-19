export const recoveryScenario = Object.freeze({
  id: "booking-recovery",
  day: "Thursday",
  operationKey: "booking-operation-1",
} as const);

export type RecoveryPolicy = "safe" | "blind-retry";
export type ProviderMode = "idempotent" | "opaque";
export type Day = "Tuesday" | "Thursday";
export type Snapshot = { day: Day; operationKey: string };
export type StoreWrite = Snapshot & { epoch: number; revision: number };
export type StoreAck = StoreWrite;
export type Attempt = Snapshot & { epoch: number; attemptId: string };
export type Receipt = Snapshot & { bookingId: string };
export type Envelope = Attempt & Receipt;
export type Confirmation = { epoch: number; bookingId: string; day: Day; claimId: string };
export type Review = { epoch: number; status: "unknown"; reason: string };

type Fact<A extends string, K extends string, P> = { actor: A; kind: K; payload: P };
export type RecoveryFact =
  | Fact<"agent", "input.delivered", { epoch: number; day: Day }>
  | Fact<"agent", "store.requested", StoreWrite>
  | Fact<"store", "store.committed", StoreAck>
  | Fact<"agent", "store.ackDelivered", StoreAck>
  | Fact<"agent", "request.sent", Attempt>
  | Fact<"provider", "provider.committed", Envelope>
  | Fact<"provider", "provider.reused", Envelope>
  | Fact<"transport", "reply.dropped", Envelope>
  | Fact<"agent", "agent.crashed", { epoch: number }>
  | Fact<"agent", "agent.restarted", StoreAck>
  | Fact<"agent", "reply.delivered", Envelope>
  | Fact<"agent", "agent.reviewRequested", Review>
  | Fact<"agent", "claim.emitted", Confirmation>
  | Fact<"device", "device.queued", Confirmation>
  | Fact<"device", "device.playbackStarted", Confirmation>;

export type RecoveryEvent = RecoveryFact & { id: string; tick: number; parents: readonly string[] };
