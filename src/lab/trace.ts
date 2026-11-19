import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { canonicalJson } from "../trace.js";
import { builtinLabAdapter, loadLabAdapter, type LabAdapter } from "./adapter-loader.js";
import { parseScenario, scenarioSchema } from "./contract.js";
import { defaultLabLimits, type LabRunOptions } from "./engine.js";
import { inspectLab } from "./verify.js";
import { executeWorld } from "./world.js";

export { loadLabAdapter, type LabAdapter } from "./adapter-loader.js";

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const id = z.string().regex(/^[!-~]+$/);
const object = z.record(z.string(), z.unknown());
const engine = "turntrace/lab-1";
const limitsSchema = z.strictObject({
  maxSteps: integer, maxDecisions: integer, maxRestarts: integer, maxDuplicates: integer,
});
const adapterSchema = z.strictObject({
  kind: z.enum(["builtin", "local"]), id, version: z.string().min(1), sha256: hash,
  runtime: z.string().nullable(), lockfileSha256: hash.nullable(),
});
const booking = z.strictObject({ bookingId: id, day: z.string() });
const decision = z.strictObject({ eventId: id, reason: z.string() }).nullable();
const resultSchema = z.strictObject({
  verdict: z.enum(["pass", "fail", "inconclusive"]),
  findings: z.array(z.strictObject({ property: z.string(), eventId: id, detail: z.string(), signature: z.string() })),
  latestIntent: z.strictObject({ inputId: id, day: z.string() }).nullable(),
  bookings: z.array(booking), played: z.array(booking.extend({ eventId: id, generation: integer })),
  review: decision, reconfirm: decision,
});
const schema = z.strictObject({
  schemaVersion: z.literal(3),
  manifest: z.strictObject({
    engine: z.literal(engine), scenarioSha256: hash, implementationSha256: hash, adapter: adapterSchema,
  }),
  scenario: scenarioSchema,
  options: z.strictObject({ limits: limitsSchema, seed: integer.nullable() }),
  choices: z.array(id), alternatives: z.array(z.array(id)),
  events: z.array(z.strictObject({ id, tick: integer, parents: z.array(id), actor: id, kind: id, payload: object })),
  status: z.enum(["terminal", "blocked", "truncated"]), reason: z.string().optional(), result: resultSchema, digest: hash,
});

export const labTraceJsonSchema = z.toJSONSchema(schema, { io: "output" });

const modules = [
  "trace.js", "lab/contract.js", "lab/engine.js", "lab/policy.js", "lab/world.js", "lab/world-channel.js",
  "lab/world-provider.js", "lab/world-device.js", "lab/world-journal.js", "lab/verify.js", "lab/resolution.js", "lab/trace.js",
  "lab/adapter-loader.js", "lab/adapter-graph.js", "lab/adapter-hooks.js",
];
let compiledDigest: string | undefined;

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function implementationDigest(): string {
  const build = new URL("../../dist/", import.meta.url);
  compiledDigest ??= digest(modules.map(name => ({
    name, sha256: createHash("sha256").update(readFileSync(new URL(name, build))).digest("hex"),
  })));
  return compiledDigest;
}

export function runLabTrace(value: unknown, adapter: LabAdapter, options: LabRunOptions = {}) {
  const scenario = parseScenario(value);
  if (scenario.policy !== adapter.manifest.id) throw new Error("Scenario policy differs from the supplied adapter");
  const limits = limitsSchema.parse({ ...defaultLabLimits, ...options.limits });
  const run = executeWorld(scenario, adapter.implementation, { ...options, limits });
  const body = {
    schemaVersion: 3 as const,
    manifest: {
      engine, implementationSha256: implementationDigest(), scenarioSha256: digest(scenario), adapter: { ...adapter.manifest },
    },
    scenario, options: { limits, seed: options.seed ?? null }, ...run,
    result: inspectLab(run.events, scenario, run.status === "terminal"),
  };
  return { ...body, digest: digest(body) };
}

export type LabTrace = ReturnType<typeof runLabTrace>;

function readEnvelope(value: unknown) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`Invalid lab trace at ${issue.path.join(".") || "root"}: ${issue.message}`);
  }
  const trace = parsed.data;
  if (trace.manifest.implementationSha256 !== implementationDigest()) throw new Error("Incompatible lab implementation digest");
  const scenario = parseScenario(trace.scenario);
  if (trace.manifest.scenarioSha256 !== digest(scenario)) throw new Error("Scenario digest mismatch");
  if (trace.manifest.adapter.id !== scenario.policy) throw new Error("Scenario and recorded adapter IDs differ");
  if (canonicalJson(value) !== canonicalJson(trace)) throw new Error("Trace contains noncanonical or unexpected fields");
  return trace;
}

/** Authenticate input, build and local adapter graph before loading user-selected code. */
export async function loadReplayLabAdapter(value: unknown, trustedPath?: string): Promise<LabAdapter> {
  const trace = readEnvelope(value);
  if (trace.manifest.adapter.kind === "local" || trustedPath !== undefined) {
    const { digest: recorded, ...body } = trace;
    if (digest(body) !== recorded) throw new Error("Invalid lab trace: digest mismatch");
  }
  return loadLabAdapter(trace.scenario, trustedPath, trace.manifest.adapter);
}

function compareSteps(label: string, recorded: readonly unknown[], computed: readonly unknown[]): void {
  for (let index = 0; index < Math.max(recorded.length, computed.length); index++) {
    if (index >= recorded.length || index >= computed.length || canonicalJson(recorded[index]) !== canonicalJson(computed[index])) {
      throw new Error(`Replay diverged at ${label} ${index + 1}`);
    }
  }
}

export function replayLabTrace(value: unknown, supplied?: LabAdapter): LabTrace {
  const saved = readEnvelope(value);
  if (!supplied && saved.manifest.adapter.kind === "local") {
    throw new Error("Replay requires the trusted local adapter supplied with --adapter");
  }
  const adapter = supplied ?? builtinLabAdapter(saved.scenario.policy);
  if (canonicalJson(adapter.manifest) !== canonicalJson(saved.manifest.adapter)) throw new Error("Incompatible adapter fingerprint");
  const trace = runLabTrace(saved.scenario, adapter, {
    limits: saved.options.limits, replayChoices: saved.choices,
    ...(saved.options.seed === null ? {} : { seed: saved.options.seed }),
  });
  compareSteps("choice", saved.choices, trace.choices);
  compareSteps("enabled set at step", saved.alternatives, trace.alternatives);
  compareSteps("event", saved.events, trace.events);
  if (saved.status !== trace.status || saved.reason !== trace.reason) throw new Error("Replay diverged at terminal status");
  if (canonicalJson(saved.result) !== canonicalJson(trace.result)) throw new Error("Replay diverged at recomputed checks");
  if (saved.digest !== trace.digest || canonicalJson(value) !== canonicalJson(trace)) throw new Error("Invalid lab trace: digest mismatch");
  return trace;
}
