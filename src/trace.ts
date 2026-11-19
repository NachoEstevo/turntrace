import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { inspectBooking } from "./checks/booking.js";
import { bookingScenario, runBooking, type Order, type Policy } from "./fixtures/booking/index.js";

const engine = "turntrace/1";
const fixture = "booking-correction/1";
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const policySchema = z.enum(["buggy", "fixed"]);
const orderSchema = z.enum(["correction-first", "commit-first"]);
const record = z.record(z.string(), z.unknown());

const traceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  manifest: z.strictObject({
    engine: z.literal(engine),
    fixture: z.literal(fixture),
    implementationSha256: sha256,
  }),
  scenario: z.strictObject({
    id: z.literal(bookingScenario.id),
    bookingId: z.literal(bookingScenario.bookingId),
    initialDay: z.literal(bookingScenario.initialDay),
    correctedDay: z.literal(bookingScenario.correctedDay),
    policy: policySchema,
    order: orderSchema,
  }),
  choices: z.array(z.string()),
  events: z.array(record),
  result: record,
  digest: sha256,
});

/** UTF-8 JSON on disk, sorted object keys, original array order and no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, canonicalJson).join(",")}]`;
  if (typeof value === "object" && Object.prototype.toString.call(value) === "[object Object]") {
    const object = value as Record<string, unknown>;
    const entries = Object.keys(object).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`,
    );
    return `{${entries.join(",")}}`;
  }
  throw new Error("Trace contains a value outside the JSON data model");
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

// Only locally shipped simulation modules participate. A trace cannot select a file.
const implementationFiles = [
  "core/scheduler.js",
  "fixtures/booking/types.js",
  "fixtures/booking/agent.js",
  "fixtures/booking/provider.js",
  "fixtures/booking/index.js",
  "checks/booking.js",
  "trace.js",
] as const;

function manifest() {
  const build = new URL("../dist/", import.meta.url);
  const modules = implementationFiles.map((name) => ({
    name,
    sha256: createHash("sha256").update(readFileSync(new URL(name, build))).digest("hex"),
  }));
  return { engine, fixture, implementationSha256: digest(modules) };
}

function assemble(
  policy: Policy,
  order: Order,
  implementation: ReturnType<typeof manifest>,
  execution: ReturnType<typeof runBooking>,
) {
  const body = {
    schemaVersion: 1 as const,
    manifest: implementation,
    scenario: { ...bookingScenario, policy, order },
    choices: execution.choices,
    events: execution.events,
    result: inspectBooking(execution.events),
  };
  return { ...body, digest: digest(body) };
}

export type Trace = ReturnType<typeof assemble>;

export function createTrace(policy: Policy, order: Order): Trace {
  policySchema.parse(policy);
  orderSchema.parse(order);
  return assemble(policy, order, manifest(), runBooking(policy, order));
}

/** Replay the actual choices and check every recorded observation against the new world. */
export function replayTrace(value: unknown): Trace {
  const parsed = traceSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`Invalid trace at ${issue.path.join(".") || "root"}: ${issue.message}`);
  }
  const saved = parsed.data;
  const implementation = manifest();
  if (saved.manifest.implementationSha256 !== implementation.implementationSha256) {
    throw new Error("Incompatible trace: implementation digest differs from this build");
  }

  const { policy, order } = saved.scenario;
  const replayed = runBooking(policy, order, saved.choices);
  // Several choices can be causally legal at the same tick. The named fixture also
  // promises a particular demonstration schedule, which the recorded choices must fit.
  const namedChoices = runBooking(policy, order).choices;
  const differentChoice = replayed.choices.findIndex((id, i) => id !== namedChoices[i]);
  if (differentChoice !== -1 || replayed.choices.length !== namedChoices.length) {
    const step = (differentChoice === -1 ? replayed.choices.length : differentChoice) + 1;
    throw new Error(`Replay diverged at step ${step}: choices disagree with schedule "${order}"`);
  }

  const trace = assemble(policy, order, implementation, replayed);
  const eventCount = Math.max(saved.events.length, trace.events.length);
  for (let index = 0; index < eventCount; index++) {
    const expected = trace.events[index];
    const recorded = saved.events[index];
    if (!expected || !recorded || canonicalJson(recorded) !== canonicalJson(expected)) {
      const id = expected?.id ?? "<end>";
      throw new Error(`Replay diverged at event ${index + 1} (${id}): recorded observation differs`);
    }
  }
  if (canonicalJson(trace.result) !== canonicalJson(saved.result)) {
    throw new Error("Replay diverged: recorded result differs from the recomputed checks");
  }
  // Keep the original JSON in this final comparison as well. A validator can drop
  // special object keys when constructing its parsed copy.
  if (saved.digest !== trace.digest || canonicalJson(value) !== canonicalJson(trace)) {
    throw new Error("Invalid trace: digest mismatch");
  }
  return trace;
}
