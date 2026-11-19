import type { JsonObject, LabEvent, Scenario } from "./contract.js";

/** Observable grounds the active instance has for handing off an unresolved booking. */
export class ResolutionEvidence {
  private readonly inFlight = new Map<string, { key: string; day: string | null; timedOut: boolean }>();
  private readonly rejected = new Set<string>();
  private recoveredKey: string | null = null;
  private rejectedInput: string | null = null;
  private awaitingReconfirmation = false;

  onRestart(snapshot: JsonObject, delivery: Scenario["delivery"], restarting: boolean): void {
    this.inFlight.clear();
    this.rejected.clear();
    this.rejectedInput = null;
    this.recoveredKey = restarting && typeof snapshot.createKey === "string" ? snapshot.createKey : null;
    this.awaitingReconfirmation = restarting && delivery === "once";
  }

  onNewerDeliveredInput(): void {
    this.awaitingReconfirmation = false;
    this.rejectedInput = null;
  }

  note(event: LabEvent, operation: JsonObject, inputId: string): void {
    const p = event.payload;
    switch (event.kind) {
      case "store.ackDelivered":
        this.rejectedInput = p.accepted === false ? inputId : null;
        break;
      case "request.sent":
        this.inFlight.set(String(p.attemptId), {
          key: String(operation.key), day: typeof operation.day === "string" ? operation.day : null, timedOut: false,
        });
        break;
      case "timer.fired":
        // An adapter may name a shared deadline independently of its request IDs.
        for (const attempt of this.inFlight.values()) attempt.timedOut = true;
        break;
      case "reply.delivered": {
        const key = String(operation.key);
        this.inFlight.delete(String(p.attemptId));
        if (p.outcome === "rejected" || p.outcome === "missing") {
          // An empty lookup before the agent ever attempted a mutation is an
          // answer. It can be ambiguous after an earlier create or recovery.
          if (operation.kind !== "query" || key === this.recoveredKey ||
              [...this.inFlight.values()].some(attempt => attempt.key === key && attempt.day !== null)) {
            this.rejected.add(key);
          }
        }
        else {
          this.rejected.delete(key);
          if (key === this.recoveredKey) this.recoveredKey = null;
        }
        break;
      }
    }
  }

  canReconfirm(): boolean {
    return this.awaitingReconfirmation;
  }

  canReview(scenario: Scenario, journal: JsonObject, inputId: string, day: string,
    receipts: ReadonlyMap<string, { day: string }>): boolean {
    if (!day) return false;
    if (inputId === this.rejectedInput) return true;
    const pending = [...this.inFlight.values()];
    if ([...receipts.values()].some(receipt => receipt.day === day) &&
        !pending.some(attempt => attempt.day !== null && attempt.day !== day)) return false;
    const hasCurrentKey = (key: string) => key === journal.createKey || key === journal.operationKey;
    if ([...this.rejected].some(hasCurrentKey)) return true;
    // A restarted opaque provider client can see the durable intent, but the
    // journal alone does not establish whether the old instance sent the create.
    if (!scenario.provider.query && !scenario.provider.idempotent &&
        this.recoveredKey !== null && hasCurrentKey(this.recoveredKey)) return true;
    if (pending.some(attempt => attempt.timedOut && hasCurrentKey(attempt.key) &&
        (attempt.day !== null || attempt.key === this.recoveredKey))) return true;
    return !scenario.provider.amend && [...receipts.values()].some(receipt => receipt.day !== day);
  }
}
