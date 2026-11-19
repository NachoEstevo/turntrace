import { arch, cpus, platform } from "node:os";
import { mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { commandJsonSchema, parseScenario, scenarioJsonSchema } from "../lab/contract.js";
import { defaultLabLimits, exploreLab, type LabLimits } from "../lab/engine.js";
import { minimizeLabTrace } from "../lab/minimize.js";
import {
  labTraceJsonSchema, loadLabAdapter, loadReplayLabAdapter, runLabTrace, type LabTrace,
} from "../lab/trace.js";
import { readJson, saveTrace } from "./files.js";
import { campaignJsonSchema, campaignManifest, type CampaignArtifact, type CampaignReport } from "./campaign.js";

const fileFlags = { adapter: { type: "string" }, out: { type: "string" }, json: { type: "boolean" } } as const;
const bounds = {
  "max-steps": { type: "string" }, "max-decisions": { type: "string" },
  "max-restarts": { type: "string" }, "max-duplicates": { type: "string" },
} as const;

function integer(name: string, value: string | boolean | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`--${name} must be a nonnegative safe integer.`);
  }
  return Number(value);
}

export function oneFile(paths: string[], command: string): string {
  if (paths.length !== 1 || !paths[0]) throw new Error(`Expected one input file for turntrace ${command}.`);
  return paths[0];
}

function checkPath(flag: string, value: string | undefined): void {
  if (value !== undefined && !value.trim()) throw new Error(`--${flag} requires a path.`);
}

export function labExit(trace: LabTrace): number {
  if (trace.result.findings.length) return 1;
  return trace.status === "terminal" ? 0 : 3;
}

export function formatLab(trace: LabTrace): string {
  const title = trace.result.findings.length ? "FAIL" : trace.status === "terminal" ? "PASS" : "INCONCLUSIVE";
  const report = trace.result;
  const active = report.bookings.map(b => `${b.bookingId} on ${b.day}`).join(", ");
  const claims = trace.events.filter(event => event.kind === "claim.emitted").map(event => {
    const claim = event.payload.claim;
    return claim && typeof claim === "object" && !Array.isArray(claim) ? String(claim.day) : "unknown";
  });
  const lines = [
    `${title}  ${trace.scenario.id} / ${trace.scenario.policy}  (${trace.status}, ${trace.choices.length} steps)`,
    `Caller requested  ${report.latestIntent?.day ?? "no booking"}`,
    `Agent confirmed   ${claims.join(", ") || "no confirmation"}`,
    `Provider holds    ${active || "no booking"}`,
    `Device played     ${report.played.map(mark => mark.day).join(", ") || "no confirmation"}`,
  ];
  if (report.review) lines.push(`Review requested  ${report.review.reason}`);
  if (report.reconfirm) lines.push(`Reconfirmation    ${report.reconfirm.reason}`);
  if (trace.reason) lines.push(trace.reason);
  for (const finding of trace.result.findings) {
    lines.push(`  FAIL ${finding.property} [${finding.eventId ?? "terminal"}]  ${finding.detail}`);
  }
  lines.push("");
  for (const event of trace.events) {
    const causes = event.parents.length ? `  <- ${event.parents.join(", ")}` : "";
    lines.push(`  t${event.tick}  [${event.id}]  ${event.actor} ${event.kind}  ${JSON.stringify(event.payload)}${causes}`);
  }
  lines.push(`SHA-256  ${trace.digest}`);
  return lines.join("\n");
}

export function schemaCommand(args: string[]): number {
  const schemas = { scenario: scenarioJsonSchema, command: commandJsonSchema, trace: labTraceJsonSchema, campaign: campaignJsonSchema };
  const [name] = args;
  if (args.length !== 1 || !name || !Object.hasOwn(schemas, name)) {
    throw new Error("Usage: turntrace schema scenario|command|trace|campaign");
  }
  console.log(JSON.stringify(schemas[name as keyof typeof schemas], null, 2));
  return 0;
}

export async function runOrExplore(command: "run" | "explore", args: string[]): Promise<number> {
  const extra = command === "explore"
    ? { "max-runs": { type: "string" }, samples: { type: "string" }, profile: { type: "boolean" }, "out-dir": { type: "string" } } as const
    : {};
  const { values, positionals } = parseArgs({
    args, allowPositionals: true, options: { ...fileFlags, ...bounds, seed: { type: "string" }, ...extra },
  });
  const { adapter: path, out, json } = values;
  checkPath("adapter", path);
  checkPath("out", out);
  const directory = values["out-dir"];
  if (directory !== undefined && typeof directory !== "string") throw new Error("--out-dir requires a directory path.");
  checkPath("out-dir", directory);
  if (directory && out && /^(?:index|history-\d{5,})\.json$/i.test(relative(directory, out))) {
    throw new Error("--out collides with a reserved campaign filename. Choose another witness path.");
  }
  const scenario = parseScenario(await readJson(oneFile(positionals, command)));
  const limits: LabLimits = {
    maxSteps: integer("max-steps", values["max-steps"], defaultLabLimits.maxSteps),
    maxDecisions: integer("max-decisions", values["max-decisions"], defaultLabLimits.maxDecisions),
    maxRestarts: integer("max-restarts", values["max-restarts"], defaultLabLimits.maxRestarts),
    maxDuplicates: integer("max-duplicates", values["max-duplicates"], defaultLabLimits.maxDuplicates),
  };
  const seedOption = values.seed === undefined ? {} : { seed: integer("seed", values.seed, 0) };
  const maxRuns = integer("max-runs", values["max-runs"], 200);
  const samples = values.samples === undefined ? {} : { samples: integer("samples", values.samples, 1) };
  if (values.samples !== undefined && values.seed === undefined) throw new Error("--samples requires --seed.");
  const adapter = await loadLabAdapter(scenario, path);
  if (command === "run") {
    const trace = runLabTrace(scenario, adapter, { limits, ...seedOption });
    if (out) saveTrace(out, trace);
    console.log(json ? JSON.stringify(trace) : formatLab(trace));
    if (out && !json) console.log(`Saved trace to ${out}`);
    return labExit(trace);
  }

  if (directory) mkdirSync(directory);
  let histories = 0;
  let violations = 0;
  const artifacts: CampaignArtifact[] | undefined = directory ? [] : undefined;
  const witness: { trace?: LabTrace; priority: number; file: string | null } = { priority: -1, file: null };
  const start = process.hrtime.bigint();
  const cpu = process.cpuUsage();
  const exploration = exploreLab(options => {
    const trace = runLabTrace(scenario, adapter, options);
    histories++;
    const exit = labExit(trace);
    if (exit === 1) violations++;
    const priority = exit === 1 ? 2 : exit === 3 ? 1 : 0;
    let file = out ?? null;
    if (directory && artifacts) {
      file = `history-${String(histories).padStart(5, "0")}.json`;
      saveTrace(join(directory, file), trace);
      const first = trace.result.findings[0];
      artifacts.push({ file, digest: trace.digest, status: trace.status, ...(first ? { firstProperty: first.property } : {}) });
    }
    if (priority > witness.priority) { witness.trace = trace; witness.priority = priority; witness.file = file; }
    return { choices: trace.choices, alternatives: trace.alternatives, status: trace.status };
  }, { limits, maxRuns, ...seedOption, ...samples });
  if (values.profile) {
    const { user, system } = process.cpuUsage(cpu);
    console.error(JSON.stringify({
      scenario: scenario.id, node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model,
      ...seedOption, ...samples, maxRuns, limits, counts: exploration.counts,
      elapsedMs: Number(process.hrtime.bigint() - start) / 1e6,
      cpuUserMs: user / 1000, cpuSystemMs: system / 1000, processPeakRssKiB: process.resourceUsage().maxRSS,
    }));
  }
  const selected = witness.trace;
  const { mode, complete, counts, pendingPrefixes, remainingSamples } = exploration;
  const report: CampaignReport = {
    schemaVersion: 1, kind: "turntrace.campaign", manifest: campaignManifest(scenario, adapter, selected),
    scenario: scenario.id, policy: scenario.policy, mode, complete, limits, maxRuns, ...seedOption, ...samples,
    histories, counts, violations, pendingPrefixes, remainingSamples,
    witness: selected ? { file: witness.file, digest: selected.digest, status: selected.status, firstFinding: selected.result.findings[0] ?? null } : null,
    ...(artifacts ? { artifacts } : {}),
  };
  if (directory) saveTrace(join(directory, "index.json"), report);
  if (selected && out) saveTrace(out, selected);
  if (json) console.log(JSON.stringify(report));
  else {
    const coverage = mode === "sampled" ? "Seeded sample" : complete ? "All bounded histories" : "Partial exploration";
    console.log(`${coverage}  ${scenario.id} / ${scenario.policy}
${histories} histories, ${counts.terminal} terminal, ${counts.blocked} blocked, ${counts.truncated} truncated, ${violations} with violations
${pendingPrefixes} unexplored prefixes, ${remainingSamples} samples pending`);
    const finding = report.witness?.firstFinding;
    if (finding) console.log(`  FAIL ${finding.property} [${finding.eventId ?? "terminal"}]  ${finding.detail}`);
    if (out && selected) console.log(`Saved witness to ${out}`);
    if (directory) console.log(`Saved all observed histories and coverage to ${directory}`);
  }
  if (violations) return 1;
  return !histories || pendingPrefixes || remainingSamples || counts.blocked || counts.truncated ? 3 : 0;
}

export async function minimizeCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true, options: {
      ...fileFlags, "max-attempts": { type: "string" }, "max-milliseconds": { type: "string" },
    },
  });
  checkPath("out", values.out);
  checkPath("adapter", values.adapter);
  const saved = await readJson(oneFile(positionals, "minimize"));
  const maxAttempts = integer("max-attempts", values["max-attempts"], 100);
  const timeBudget = values["max-milliseconds"] === undefined ? {}
    : { maxMilliseconds: integer("max-milliseconds", values["max-milliseconds"], 0) };
  const adapter = await loadReplayLabAdapter(saved, values.adapter);
  const result = minimizeLabTrace(saved, adapter, { maxAttempts, ...timeBudget });
  if (values.out) saveTrace(values.out, result.reduced);
  const { status, attempts, inconclusiveAttempts, removedPerturbations, target } = result;
  if (values.json) {
    console.log(JSON.stringify({
      status, attempts, maxAttempts, ...timeBudget, elapsedMilliseconds: result.elapsedMilliseconds, exhaustedBy: result.exhaustedBy,
      inconclusiveAttempts, inconclusiveReasons: result.inconclusiveReasons, removedPerturbations, target,
      originalDigest: result.original.digest, reducedDigest: result.reduced.digest,
    }));
  } else {
    console.log(`Reduction ${status} under optional group and action removal.
Preserved ${target.property} (${target.signature}).
Removed ${removedPerturbations.length} perturbations in ${attempts}/${maxAttempts} attempts (${inconclusiveAttempts} inconclusive).
Original ${result.original.digest}
Reduced  ${result.reduced.digest}`);
    if (result.maxMilliseconds !== null) {
      console.log(`Time budget  ${Math.round(result.elapsedMilliseconds ?? 0)} / ${result.maxMilliseconds} ms`);
    }
    if (result.exhaustedBy) console.log(`Reduction stopped at the ${result.exhaustedBy} limit.`);
    if (values.out) console.log(`Saved reduced trace to ${values.out}`);
  }
  // Every returned artifact still exhibits the requested failure signature.
  return 1;
}
