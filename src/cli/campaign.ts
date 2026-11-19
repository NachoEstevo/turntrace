import { createHash } from "node:crypto";
import { z } from "zod";
import type { LabAdapter, LabTrace } from "../lab/trace.js";
import { canonicalJson } from "../trace.js";

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const status = z.enum(["terminal", "blocked", "truncated"]);
const finding = z.strictObject({
  property: z.string(), eventId: z.string(), detail: z.string(), signature: z.string(),
});
const artifact = z.strictObject({
  file: z.string().regex(/^history-\d{5,}\.json$/), digest: hash, status, firstProperty: z.string().optional(),
});
export type CampaignArtifact = z.infer<typeof artifact>;

const campaign = z.strictObject({
  kind: z.literal("turntrace.campaign"), schemaVersion: z.literal(1),
  scenario: z.string(), policy: z.string(), mode: z.enum(["sampled", "exhaustive"]), complete: z.boolean(),
  limits: z.strictObject({ maxSteps: count, maxDecisions: count, maxRestarts: count, maxDuplicates: count }),
  maxRuns: count, seed: count.optional(), samples: count.optional(),
  histories: count, counts: z.strictObject({ terminal: count, blocked: count, truncated: count }),
  violations: count, pendingPrefixes: count, remainingSamples: count,
  manifest: z.strictObject({
    scenarioSha256: hash, engine: z.string().nullable(), implementationSha256: hash.nullable(),
    adapter: z.strictObject({
      kind: z.enum(["builtin", "local"]), id: z.string(), version: z.string(), sha256: hash,
      runtime: z.string().nullable(), lockfileSha256: hash.nullable(),
    }),
  }),
  witness: z.strictObject({ file: z.string().nullable(), digest: hash, status, firstFinding: finding.nullable() }).nullable(),
  artifacts: z.array(artifact).optional(),
});
export const campaignJsonSchema = z.toJSONSchema(campaign, { io: "output" });
export type CampaignReport = z.infer<typeof campaign>;

export function campaignManifest(scenario: LabTrace["scenario"], adapter: LabAdapter, witness?: LabTrace) {
  if (witness) return witness.manifest;
  return {
    scenarioSha256: createHash("sha256").update(canonicalJson(scenario), "utf8").digest("hex"),
    engine: null, implementationSha256: null, adapter: adapter.manifest,
  };
}
