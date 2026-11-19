#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { Order, Policy } from "../fixtures/booking/index.js";
import { createTrace, replayTrace, type Trace } from "../trace.js";
import { formatComparison, formatRun } from "./report.js";

const help = `Turntrace replays a synthetic voice booking in two delivery orders.

  turntrace demo [--order correction-first|commit-first] [--policy buggy|fixed]
  turntrace demo --order <order> --policy <policy> --out <trace.json>
  turntrace replay <trace.json>

Demo compares all four cases by default. Select one order and policy to see
individual observations. --out saves that case and replaces an existing file.
Replay runs the recorded choices again and checks the observations and digest.

Exit codes: 0 checks passed, 1 a booking check failed, 2 invalid input or replay.
From a checkout, use node dist/cli/index.js in place of turntrace.`;

async function saveTrace(path: string, trace: Trace): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(trace, null, 2) + "\n", { flag: "wx" });
    await rename(temporary, path);
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

async function main([command, ...args]: string[]): Promise<number> {
  if (!command || command === "--help" || command === "-h" ||
    (["demo", "replay"].includes(command) && args.length === 1 && ["-h", "--help"].includes(args[0]!))) {
    console.log(help);
    return 0;
  }
  if (command === "demo") return demo(args);
  if (command === "replay") {
    const { positionals } = parseArgs({ args, allowPositionals: true });
    const [path] = positionals;
    if (!path || positionals.length !== 1) throw new Error("Usage: turntrace replay <trace.json>");
    const trace = replayTrace(JSON.parse(await readFile(path, "utf8")));
    console.log(`Verified replay of ${trace.choices.length} choices.\n`);
    console.log(formatRun(trace));
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
