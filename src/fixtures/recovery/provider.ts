import type { ProviderMode, Receipt, Snapshot } from "./types.js";

type CreateResult = (Receipt & { kind: "committed" | "reused" }) | { kind: "conflict"; operationKey: string };

export class RecoveryProvider {
  private readonly ledger: Receipt[] = [];

  constructor(private readonly mode: ProviderMode) {}

  create({ operationKey, day }: Snapshot): CreateResult {
    if (this.mode === "idempotent") {
      const previous = this.ledger.find(booking => booking.operationKey === operationKey);
      if (previous) {
        if (previous.day !== day) return { kind: "conflict", operationKey };
        return { ...previous, kind: "reused" };
      }
    }
    const receipt = { operationKey, day, bookingId: `booking-${this.ledger.length + 1}` };
    this.ledger.push(receipt);
    return { ...receipt, kind: "committed" };
  }
}
