import { replayTrace as replayBookingTrace, type Trace } from "./trace.js";
import { replayRecoveryTrace, type RecoveryTrace } from "./recovery-trace.js";

export { canonicalJson, createTrace, type Trace } from "./trace.js";
export { createRecoveryTrace, replayRecoveryTrace, type RecoveryTrace } from "./recovery-trace.js";
export type { ProviderMode, RecoveryPolicy } from "./fixtures/recovery/index.js";

export function replayTrace(value: { readonly schemaVersion: 1 }): Trace;
export function replayTrace(value: { readonly schemaVersion: 2 }): RecoveryTrace;
export function replayTrace(value: unknown): Trace | RecoveryTrace;
export function replayTrace(value: unknown): Trace | RecoveryTrace {
  if (typeof value === "object" && value !== null && "schemaVersion" in value) {
    if (value.schemaVersion === 1) return replayBookingTrace(value);
    if (value.schemaVersion === 2) return replayRecoveryTrace(value);
  }
  throw new Error("Invalid trace at schemaVersion: expected 1 or 2");
}
