import type { Snapshot } from "./types.js";

export class RecoveryStore {
  private snapshot: Snapshot | null = null;
  private revision = 0;

  write(snapshot: Snapshot): number {
    this.snapshot = { day: snapshot.day, operationKey: snapshot.operationKey };
    return ++this.revision;
  }

  read(): { revision: number; snapshot: Snapshot | null } {
    return { revision: this.revision, snapshot: this.snapshot && { ...this.snapshot } };
  }
}
