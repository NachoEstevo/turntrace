import { replayTrace as replayBookingTrace, type Trace } from "./trace.js";
import { replayRecoveryTrace, type RecoveryTrace } from "./recovery-trace.js";
import { replayLabTrace, type LabTrace } from "./lab/trace.js";

export { canonicalJson, createTrace, type Trace } from "./trace.js";
export { createRecoveryTrace, replayRecoveryTrace, type RecoveryTrace } from "./recovery-trace.js";
export type { ProviderMode, RecoveryPolicy } from "./fixtures/recovery/index.js";
export { labTraceJsonSchema, loadLabAdapter, loadReplayLabAdapter, replayLabTrace, runLabTrace, type LabTrace, type LabAdapter } from "./lab/trace.js";
export { parseScenario, scenarioJsonSchema, commandJsonSchema } from "./lab/contract.js";
export type { AgentAdapter, AgentCommand, AgentStep, DeliveredEvent, RecoveryContext, LabEvent, Scenario } from "./lab/contract.js";
export { LabScheduler, exploreLab, defaultLabLimits } from "./lab/engine.js";
export type { LabRun, LabRunOptions, LabAction, LabLimits, LabExploreOptions, LabExploration } from "./lab/engine.js";
export { minimizeLabTrace } from "./lab/minimize.js";

export function replayTrace(value: { readonly schemaVersion: 1 }): Trace;
export function replayTrace(value: { readonly schemaVersion: 2 }): RecoveryTrace;
export function replayTrace(value: { readonly schemaVersion: 3 }): LabTrace;
export function replayTrace(value: unknown): Trace | RecoveryTrace | LabTrace;
export function replayTrace(value: unknown): Trace | RecoveryTrace | LabTrace {
  if (typeof value === "object" && value !== null && "schemaVersion" in value) {
    if (value.schemaVersion === 1) return replayBookingTrace(value);
    if (value.schemaVersion === 2) return replayRecoveryTrace(value);
    if (value.schemaVersion === 3) return replayLabTrace(value);
  }
  throw new Error("Invalid trace at schemaVersion: expected 1, 2 or 3");
}
