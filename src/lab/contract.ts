import { z } from "zod";
import { validateDependencies } from "./engine.js";

const label = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const messageId = z.string().min(1).regex(/^[!-~]+$/);
const ticks = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const day = z.enum(["Tuesday", "Thursday"]);
export type Day = z.infer<typeof day>;
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

function isJsonValue(value: unknown, ancestors: Set<object>): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  if (Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) return false;
  } else if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    return false;
  }
  ancestors.add(value);
  const valid = Object.values(value).every(child => isJsonValue(child, ancestors));
  ancestors.delete(value);
  return valid;
}

// A generic domain payload may contain any JSON key, including "__proto__".
// Zod records omit that key. Preserve the same JSON tree that replay will read.
const jsonObject: z.ZodType<JsonObject> = z.any()
  .refine(value => value !== null && typeof value === "object" && !Array.isArray(value) &&
    isJsonValue(value, new Set()), { message: "Expected a JSON object with finite numbers and no cycles", abort: true })
  .overwrite(value => JSON.parse(JSON.stringify(value)))
  .meta({ type: "object", additionalProperties: true });

const provider = z.strictObject({ idempotent: z.boolean(), query: z.boolean(), amend: z.boolean() });
export type ProviderCapabilities = z.infer<typeof provider>;

const delay = ticks.default(1);
const delays = z.strictObject({
  input: delay, inputAck: delay, store: delay, storeAck: delay,
  provider: delay, providerReply: delay, speech: delay, playback: delay, flush: delay,
});
const channel = delays.keyof();
export type Channel = z.infer<typeof channel>;

const actionFields = {
  id: label, tick: ticks, parents: z.array(label).default([]),
  optional: z.boolean().optional(), group: label.optional(),
};
const action = z.discriminatedUnion("kind", [
  z.strictObject({ ...actionFields, kind: z.literal("input"), inputId: messageId, day }),
  z.strictObject({ ...actionFields, kind: z.literal("signal"), name: messageId, data: jsonObject.default({}) }),
  z.strictObject({ ...actionFields, kind: z.literal("crash") }),
  z.strictObject({ ...actionFields, kind: z.literal("restart") }),
  z.strictObject({ ...actionFields, kind: z.literal("end-call") }),
  z.strictObject({ ...actionFields, kind: z.literal("fail-next-provider") }),
  z.strictObject({ ...actionFields, kind: z.literal("drop-next"), channel }),
  z.strictObject({ ...actionFields, kind: z.literal("duplicate-next"), channel }),
  z.strictObject({ ...actionFields, kind: z.literal("delay-next"), channel, delayTicks: ticks }),
]);
export type ScenarioAction = z.infer<typeof action>;

const scenario = z.strictObject({
  schemaVersion: z.literal(1), id: label, policy: label.default("safe"), provider,
  delivery: z.enum(["once", "recoverable"]),
  expectation: z.enum(["confirmed", "review", "reconfirm", "settled", "observe"]),
  delays: delays.prefault({}), fifo: z.array(channel).default([]), playbackTicks: ticks.default(2),
  actions: z.array(action),
});
export type Scenario = z.infer<typeof scenario>;
export { scenario as scenarioSchema };
export const scenarioJsonSchema = z.toJSONSchema(scenario, { io: "input" });

export function parseScenario(value: unknown): Scenario {
  const parsed = scenario.parse(value);
  if (new Set(parsed.fifo).size !== parsed.fifo.length) throw new Error("Duplicate FIFO channel");
  const byId = new Map<string, ScenarioAction>();
  const inputDays = new Map<string, Day>();
  for (const item of parsed.actions) {
    if (byId.has(item.id)) throw new Error(`Duplicate action ID "${item.id}"`);
    byId.set(item.id, item);
    if (item.group && !item.optional) throw new Error(`Only optional actions can belong to group "${item.group}"`);
    if (new Set(item.parents).size !== item.parents.length) throw new Error(`Duplicate parent of "${item.id}"`);
    if (item.kind === "input") {
      const previous = inputDays.get(item.inputId);
      if (previous && previous !== item.day) throw new Error(`Conflicting content for input "${item.inputId}"`);
      inputDays.set(item.inputId, item.day);
    }
  }
  validateDependencies(parsed.actions, byId);
  return parsed;
}

const operation = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("create"), key: messageId, day }),
  z.strictObject({ kind: z.literal("amend"), key: messageId, bookingId: messageId, day }),
  z.strictObject({ kind: z.literal("query"), key: messageId }),
]);
export type BookingOperation = z.infer<typeof operation>;
const command = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("store"), requestId: messageId, expectedRevision: ticks, snapshot: jsonObject }),
  z.strictObject({ kind: z.literal("input-ack"), inputId: messageId }),
  z.strictObject({ kind: z.literal("provider"), requestId: messageId, operation }),
  z.strictObject({ kind: z.literal("speech"), generation: ticks, claim: z.strictObject({ bookingId: messageId, day }) }),
  z.strictObject({ kind: z.literal("flush"), generation: ticks }),
  z.strictObject({ kind: z.literal("timer"), timerId: messageId, delayTicks: ticks }),
  z.strictObject({ kind: z.literal("review"), reason: z.string().regex(/\S/) }),
  z.strictObject({ kind: z.literal("reconfirm"), reason: z.string().regex(/\S/) }),
  z.strictObject({ kind: z.literal("observe"), name: messageId, data: jsonObject }),
]);
export type AgentCommand = z.infer<typeof command>;
export const commandJsonSchema = z.toJSONSchema(command, { io: "input" });
const commands = z.array(command);
export function parseAgentCommands(value: unknown): AgentCommand[] {
  return commands.parse(value);
}

export interface RecoveryContext {
  epoch: number;
  revision: number;
  snapshot: JsonObject | null;
  provider: ProviderCapabilities;
  delivery: Scenario["delivery"];
}
export interface ProviderReply {
  kind: "provider-reply";
  requestId: string;
  operation: BookingOperation;
  outcome: "committed" | "found" | "missing" | "rejected";
  bookingId: string | null;
  day: Day | null;
  reason?: string;
  failure?: "precommit";
}
export type DeliveredEvent =
  | { kind: "start" }
  | { kind: "input"; inputId: string; day: Day; sourceRevision: number }
  | { kind: "signal"; name: string; data: JsonObject }
  | { kind: "store-ack"; requestId: string; revision: number; accepted: boolean }
  | ProviderReply
  | { kind: "timer"; timerId: string }
  | { kind: "end-call" };

export interface AgentStep<State> {
  next: State;
  commands: readonly AgentCommand[];
}
export interface AgentAdapter<State = unknown> {
  id: string;
  version: string;
  init(context: RecoveryContext): State;
  step(state: State, input: DeliveredEvent): AgentStep<State>;
}
export interface LabEvent {
  id: string;
  tick: number;
  parents: string[];
  actor: string;
  kind: string;
  payload: JsonObject;
}

const agent = z.object({
  id: label, version: z.string().min(1),
  init: z.custom<AgentAdapter["init"]>(v => typeof v === "function"),
  step: z.custom<AgentAdapter["step"]>(v => typeof v === "function"),
});
/** Inspect the trusted module's default export. Preserve the methods' receiver. */
export function parseAgentAdapter(value: unknown): AgentAdapter {
  agent.parse(value);
  return value as AgentAdapter;
}

const step = z.strictObject({ next: z.unknown(), commands });
export function assertSynchronousState(state: unknown): void {
  if (state !== null && (typeof state === "object" || typeof state === "function") &&
      "then" in state && typeof state.then === "function") {
    throw new Error("An adapter must return its volatile state synchronously");
  }
}

export function parseAgentStep<State>(value: AgentStep<State>): AgentStep<State>;
export function parseAgentStep(value: unknown): AgentStep<unknown>;
export function parseAgentStep(value: unknown): AgentStep<unknown> {
  if (typeof value !== "object" || value === null || !Object.hasOwn(value, "next")) {
    throw new Error("A synchronous adapter step must return { next, commands }");
  }
  const parsed = step.parse(value);
  assertSynchronousState(parsed.next);
  return parsed;
}
