import type { JsonObject } from "./contract.js";

type Write = { epoch: number; writeId: string; expectedRevision: number; snapshot: JsonObject; busy: boolean };

/** Agent restarts do not reset this actor's snapshot or revision. */
export class WorldJournal {
  private epoch = 0;
  private revision = 0;
  private snapshot: JsonObject | null = null;
  private outstanding: string | undefined;

  activate() {
    this.epoch++;
    this.outstanding = undefined;
    return { epoch: this.epoch, revision: this.revision, snapshot: structuredClone(this.snapshot) };
  }

  request(epoch: number, writeId: string, expectedRevision: number, snapshot: JsonObject): Write {
    const busy = this.outstanding !== undefined;
    if (!busy) this.outstanding = writeId;
    return { epoch, writeId, expectedRevision, snapshot: structuredClone(snapshot), busy };
  }

  apply(write: Write): { accepted: boolean; revision: number; reason?: string } {
    if (write.epoch !== this.epoch) return { accepted: false, revision: this.revision, reason: "stale-epoch" };
    if (write.busy) return { accepted: false, revision: this.revision, reason: "write-outstanding" };
    if (write.expectedRevision !== this.revision) {
      return { accepted: false, revision: this.revision, reason: "revision-mismatch" };
    }
    this.snapshot = structuredClone(write.snapshot);
    this.revision++;
    return { accepted: true, revision: this.revision };
  }

  acknowledge(write: Write): void {
    if (this.epoch === write.epoch && this.outstanding === write.writeId) this.outstanding = undefined;
  }
}
