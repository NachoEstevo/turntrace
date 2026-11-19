#!/usr/bin/env node
import { parseArgs } from "node:util";
import type { Order, Policy } from "../fixtures/booking/index.js";
import { replayTrace } from "../index.js";
import { loadReplayLabAdapter, replayLabTrace } from "../lab/trace.js";
import { createRecoveryTrace } from "../recovery-trace.js";
import { createTrace } from "../trace.js";
import { readJson, saveTrace } from "./files.js";
import { oneFile } from "./arguments.js";
import { compareCommand } from "./compare.js";
import { formatLab, labExit, minimizeCommand, runOrExplore, schemaCommand } from "./lab.js";
import { formatRecoveryComparison, formatRecoveryRun } from "./recovery.js";
import { formatComparison, formatRun } from "./report.js";

const help = `Turntrace reproduces booking races and agent recovery in a synthetic voice call.

  turntrace demo [--order correction-first|commit-first] [--policy buggy|fixed]
  turntrace demo --order <order> --policy <policy> --out <trace.json>
  turntrace recovery [--provider idempotent|opaque] [--policy safe|blind-retry] [--out <trace.json>]
  turntrace run <scenario.json> [--adapter <trusted.mjs>] [--out <trace.json>] [--seed N]
  turntrace explore <scenario.json> [--adapter <trusted.mjs>] [--max-runs N] [--out <witness.json>] [--out-dir <new-directory>]
  turntrace minimize <trace.json> [--adapter <trusted.mjs>] [--max-attempts N] [--max-milliseconds N] [--out <reduced.json>]
  turntrace compare <left.json> <right.json> [--adapter <trusted.mjs>] [--observation NAME] [--max-pairs N] [--out-dir <new-directory>] [--json]
  turntrace replay <trace.json> [--adapter <trusted.mjs>]
  turntrace schema scenario|command|trace|campaign

Demo compares all four cases by default. Select one order and policy to see
individual observations. Choose a new filename for --out to preserve prior traces.
Recovery drops a provider reply and restarts the agent. By default it compares
both providers using the safe policy. Select one provider for all events or --out.
Replay runs the recorded choices again and checks the observations and digest.

Run and explore accept --max-steps, --max-decisions, --max-restarts and
--max-duplicates. Explore enumerates up to 200 histories by default.
Use --seed N [--samples N] to sample, --profile for measured CPU and memory
on stderr, and --json for machine-readable results from the lab commands.
Minimize writes a fresh failing case when --out is supplied.
Compare verifies two schema 3 runs and tests opposite orders under a common
continuation. The default budget is 64 pairs. Select separate trusted modules
with --left-adapter and --right-adapter when the paths differ. A completed
comparison returns 0, an inconclusive contrast 3, and invalid input or replay 2.

Exit codes: 0 checks passed, 1 property violation, 2 invalid input or replay,
3 inconclusive exploration. An observed violation takes precedence over a cutoff.
From a checkout, use node dist/cli/index.js in place of turntrace.`;

async function demo(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { policy: { type: "string" }, order: { type: "string" }, out: { type: "string" } },
  });
  const { policy, order, out } = values;
  if (policy !== undefined && policy !== "buggy" && policy !== "fixed") {
    throw new Error("--policy accepts buggy or fixed.");
  }
  if (order !== undefined && order !== "correction-first" && order !== "commit-first") {
    throw new Error("--order accepts correction-first or commit-first.");
  }
  if (out !== undefined && (!out || !policy || !order)) {
    throw new Error("--out requires a file path and a single case. Set --order and --policy.");
  }
  const orders: Order[] = order ? [order] : ["correction-first", "commit-first"];
  const policies: Policy[] = policy ? [policy] : ["buggy", "fixed"];
  const traces = orders.flatMap((selected) => policies.map((agent) => createTrace(agent, selected)));
  const single = traces.length === 1 ? traces[0] : undefined;
  if (out && single) saveTrace(out, single);
  console.log(single ? formatRun(single) : formatComparison(traces));
  if (out) console.log(`Saved trace to ${out}`);
  return traces.some((trace) => trace.result.verdict === "fail") ? 1 : 0;
}

async function recovery(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { provider: { type: "string" }, policy: { type: "string" }, out: { type: "string" } },
  });
  const { provider, policy = "safe", out } = values;
  if (provider !== undefined && provider !== "idempotent" && provider !== "opaque") {
    throw new Error("--provider accepts idempotent or opaque.");
  }
  if (policy !== "safe" && policy !== "blind-retry") {
    throw new Error("--policy accepts safe or blind-retry.");
  }
  if (out !== undefined && (!out || !provider)) {
    throw new Error("--out requires a file path and a single case. Set --provider.");
  }
  if (provider) {
    const trace = createRecoveryTrace(policy, provider);
    if (out) saveTrace(out, trace);
    console.log(formatRecoveryRun(trace));
    if (out) console.log(`Saved trace to ${out}`);
    return trace.result.verdict === "pass" ? 0 : 1;
  }
  const traces = [createRecoveryTrace(policy, "idempotent"), createRecoveryTrace(policy, "opaque")];
  console.log(formatRecoveryComparison(traces));
  return traces.some((trace) => trace.result.verdict === "fail") ? 1 : 0;
}

async function main([command, ...args]: string[]): Promise<number> {
  if (!command || command === "--help" || command === "-h" ||
    (["demo", "recovery", "run", "explore", "minimize", "compare", "replay", "schema"].includes(command) &&
      args.length === 1 && ["-h", "--help"].includes(args[0]!))) {
    console.log(help);
    return 0;
  }
  if (command === "demo") return demo(args);
  if (command === "recovery") return recovery(args);
  if (command === "run" || command === "explore") return runOrExplore(command, args);
  if (command === "minimize") return minimizeCommand(args);
  if (command === "compare") return compareCommand(args);
  if (command === "schema") return schemaCommand(args);
  if (command === "replay") {
    const { positionals, values } = parseArgs({
      args, allowPositionals: true, options: { adapter: { type: "string" }, json: { type: "boolean" } },
    });
    const saved = await readJson(oneFile(positionals, "replay"));
    if (typeof saved === "object" && saved !== null && "schemaVersion" in saved && saved.schemaVersion === 3) {
      const adapter = await loadReplayLabAdapter(saved, values.adapter);
      const trace = replayLabTrace(saved, adapter);
      console.log(values.json ? JSON.stringify(trace) : `Verified replay of ${trace.choices.length} choices.\n\n${formatLab(trace)}`);
      return labExit(trace);
    }
    if (values.adapter !== undefined) throw new Error("--adapter applies to schema 3 lab traces.");
    const trace = replayTrace(saved);
    if (values.json) console.log(JSON.stringify(trace));
    else if (trace.schemaVersion === 1 || trace.schemaVersion === 2) {
      console.log(`Verified replay of ${trace.choices.length} choices.\n`);
      console.log(trace.schemaVersion === 1 ? formatRun(trace) : formatRecoveryRun(trace));
    }
    return trace.result.verdict === "pass" ? 0 : 1;
  }
  throw new Error(`Unknown command "${command}". Run turntrace --help.`);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(process.argv.slice(2).includes("--json") ? JSON.stringify({ error: message }) : `Turntrace: ${message}`);
  process.exitCode = 2;
}
