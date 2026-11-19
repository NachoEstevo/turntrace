import { recoveryScenario } from "./types.js";
import type { Attempt, Confirmation, Day, Envelope, ProviderMode, RecoveryPolicy, Review, Snapshot, StoreAck, StoreWrite } from "./types.js";

export type RecoveryDecision = { kind: "retry"; attempt: Attempt } | { kind: "review"; review: Review };

export class RecoveryAgent {
  private pendingWrite?: StoreWrite;
  private outstanding?: Attempt;

  constructor(readonly epoch: number, private readonly policy: RecoveryPolicy, private readonly providerMode: ProviderMode) {}

  receiveInput(day: Day): StoreWrite {
    this.pendingWrite = { day, operationKey: recoveryScenario.operationKey, epoch: this.epoch, revision: 1 };
    return { ...this.pendingWrite };
  }

  receiveStoreAck(ack: StoreAck): Attempt | undefined {
    const pending = this.pendingWrite;
    if (!pending || ack.epoch !== pending.epoch || ack.revision !== pending.revision ||
        ack.day !== pending.day || ack.operationKey !== pending.operationKey) return;
    delete this.pendingWrite;
    return this.submit(pending);
  }

  recover(snapshot: Snapshot): RecoveryDecision {
    if (this.policy === "blind-retry") {
      return { kind: "retry", attempt: this.submit({ ...snapshot, operationKey: `booking-operation-${this.epoch}` }) };
    }
    if (this.providerMode === "idempotent") return { kind: "retry", attempt: this.submit(snapshot) };
    return {
      kind: "review",
      review: {
        epoch: this.epoch, status: "unknown",
        reason: "This instance has no provider receipt. The provider supports neither lookup nor idempotent retry.",
      },
    };
  }

  receiveReply(envelope: Envelope): Confirmation | undefined {
    const attempt = this.outstanding;
    if (!attempt || envelope.epoch !== this.epoch || envelope.attemptId !== attempt.attemptId ||
        envelope.operationKey !== attempt.operationKey || envelope.day !== attempt.day) return;
    delete this.outstanding;
    return { epoch: this.epoch, bookingId: envelope.bookingId, day: envelope.day, claimId: "confirmation-1" };
  }

  private submit(snapshot: Snapshot): Attempt {
    // This cut permits one outbound attempt per instance.
    const { operationKey, day } = snapshot;
    this.outstanding = { operationKey, day, epoch: this.epoch, attemptId: `attempt-${this.epoch}` };
    return { ...this.outstanding };
  }
}
