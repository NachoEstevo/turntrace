#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { link, open, readFile, rm } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { Order, Policy } from "../fixtures/booking/index.js";
import { replayTrace } from "../index.js";
import { createRecoveryTrace, type RecoveryTrace } from "../recovery-trace.js";
import { createTrace, type Trace } from "../trace.js";
import { formatRecoveryComparison, formatRecoveryRun } from "./recovery.js";
import { formatComparison, formatRun } from "./report.js";

const help = `Turntrace reproduces booking races and agent recovery in a synthetic voice call.

  turntrace demo [--order correction-first|commit-first] [--policy buggy|fixed]
  turntrace demo --order <order> --policy <policy> --out <trace.json>
  turntrace recovery [--provider idempotent|opaque] [--policy safe|blind-retry] [--out <trace.json>]
  turntrace replay <trace.json>

Demo compares all four cases by default. Select one order and policy to see
individual observations. Choose a new filename for --out to preserve prior traces.
Recovery drops a provider reply and restarts the agent. By default it compares
both providers using the safe policy. Select one provider for all events or --out.
Replay runs the recorded choices again and checks the observations and digest.

Exit codes: 0 checks passed, 1 a booking check failed, 2 invalid input or replay.
From a checkout, use node dist/cli/index.js in place of turntrace.`;

async function saveTrace(path: string, trace: Trace | RecoveryTrace): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx");
  try {
    try {
      await file.writeFile(JSON.stringify(trace, null, 2) + "\n", "utf8");
    } finally {
      await file.close();
    }
    // Publish the complete file atomically, including when two exports choose the same name.
    await link(temporary, path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(`Trace already exists at ${path}. Choose a new filename.`);
    }
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

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
  if (out && single) await saveTrace(out, single);
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
    if (out) await saveTrace(out, trace);
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
    (["demo", "recovery", "replay"].includes(command) && args.length === 1 && ["-h", "--help"].includes(args[0]!))) {
    console.log(help);
    return 0;
  }
  if (command === "demo") return demo(args);
  if (command === "recovery") return recovery(args);
  if (command === "replay") {
    const { positionals } = parseArgs({ args, allowPositionals: true });
    const [path] = positionals;
    if (!path || positionals.length !== 1) throw new Error("Usage: turntrace replay <trace.json>");
    const saved: unknown = JSON.parse(await readFile(path, "utf8"));
    const trace = replayTrace(saved);
    console.log(`Verified replay of ${trace.choices.length} choices.\n`);
    console.log(trace.schemaVersion === 1 ? formatRun(trace) : formatRecoveryRun(trace));
    return trace.result.verdict === "pass" ? 0 : 1;
  }
  throw new Error(`Unknown command "${command}". Run turntrace --help.`);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(`Turntrace: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
