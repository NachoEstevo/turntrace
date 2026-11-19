import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { inspectRecovery } from "./checks/recovery.js";
import { recoveryScenario, runRecovery, type ProviderMode, type RecoveryPolicy } from "./fixtures/recovery/index.js";
import { canonicalJson } from "./trace.js";

const engine = "turntrace/2";
const fixture = "booking-recovery/1";
const policySchema = z.enum(["safe", "blind-retry"]);
const providerSchema = z.enum(["idempotent", "opaque"]);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const record = z.record(z.string(), z.unknown());

const traceSchema = z.strictObject({
  schemaVersion: z.literal(2),
  manifest: z.strictObject({
    engine: z.literal(engine),
    fixture: z.literal(fixture),
    implementationSha256: sha256,
  }),
  scenario: z.strictObject({
    id: z.literal(recoveryScenario.id),
    day: z.literal(recoveryScenario.day),
    operationKey: z.literal(recoveryScenario.operationKey),
    policy: policySchema,
    provider: providerSchema,
  }),
  choices: z.array(z.string()),
  events: z.array(record),
  result: record,
  digest: sha256,
});

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

// Fixed local paths cover the recovery scheduler, actors, checker and replay code.
// trace.js supplies the canonical encoder shared with the historical trace format.
const implementationFiles = [
  "core/scheduler.js",
  "fixtures/recovery/types.js",
  "fixtures/recovery/agent.js",
  "fixtures/recovery/provider.js",
  "fixtures/recovery/store.js",
  "fixtures/recovery/index.js",
  "checks/recovery.js",
  "trace.js",
  "recovery-trace.js",
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
  policy: RecoveryPolicy,
  provider: ProviderMode,
  implementation: ReturnType<typeof manifest>,
  execution: ReturnType<typeof runRecovery>,
) {
  const body = {
    schemaVersion: 2 as const,
    manifest: implementation,
    scenario: { ...recoveryScenario, policy, provider },
    choices: execution.choices,
    events: execution.events,
    result: inspectRecovery(execution.events, provider),
  };
  return { ...body, digest: digest(body) };
}

export type RecoveryTrace = ReturnType<typeof assemble>;

export function createRecoveryTrace(policy: RecoveryPolicy, provider: ProviderMode): RecoveryTrace {
  policySchema.parse(policy);
  providerSchema.parse(provider);
  return assemble(policy, provider, manifest(), runRecovery(policy, provider));
}

export function replayRecoveryTrace(value: unknown): RecoveryTrace {
  const parsed = traceSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`Invalid trace at ${issue.path.join(".") || "root"}: ${issue.message}`);
  }
  const saved = parsed.data;
  const implementation = manifest();
  if (saved.manifest.implementationSha256 !== implementation.implementationSha256) {
    throw new Error("Incompatible trace: recovery implementation digest differs from this build");
  }

  const { policy, provider } = saved.scenario;
  const replayed = runRecovery(policy, provider, saved.choices);
  const scheduled = runRecovery(policy, provider).choices;
  for (let index = 0; index < Math.max(replayed.choices.length, scheduled.length); index++) {
    if (replayed.choices[index] !== scheduled[index]) {
      throw new Error(`Replay diverged at step ${index + 1}: choices disagree with the recovery schedule`);
    }
  }
  const trace = assemble(policy, provider, implementation, replayed);
  for (let index = 0; index < Math.max(trace.events.length, saved.events.length); index++) {
    const expected = trace.events[index];
    const recorded = saved.events[index];
    if (!expected || !recorded || canonicalJson(expected) !== canonicalJson(recorded)) {
      throw new Error(`Replay diverged at event ${index + 1} (${expected?.id ?? "<end>"}): recorded observation differs`);
    }
  }
  if (canonicalJson(trace.result) !== canonicalJson(saved.result)) {
    throw new Error("Replay diverged: recorded result differs from the recomputed checks");
  }
  if (saved.digest !== trace.digest || canonicalJson(value) !== canonicalJson(trace)) {
    throw new Error("Invalid trace: digest mismatch");
  }
  return trace;
}
