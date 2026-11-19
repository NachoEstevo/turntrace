import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { contrastLabTraces, type ContrastReport } from "../lab/contrast.js";
import type { LabEvent } from "../lab/contract.js";
import { loadReplayLabAdapter, replayLabTrace } from "../lab/trace.js";
import { checkPath, integer } from "./arguments.js";
import { readJson, saveTrace } from "./files.js";

async function verifyInput(side: string, path: string, trustedAdapter?: string) {
  try {
    const saved = await readJson(path);
    if (!saved || typeof saved !== "object" || !("schemaVersion" in saved) || saved.schemaVersion !== 3) {
      throw new Error("compare requires schema 3 lab traces with recorded enabled choices. Use replay for historical demos.");
    }
    const adapter = await loadReplayLabAdapter(saved, trustedAdapter);
    return { trace: replayLabTrace(saved, adapter), adapter };
  } catch (error) {
    throw new Error(`${side} input (${path}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

function eventLine(event: LabEvent | null): string {
  if (!event) return "(none)";
  return `t${event.tick}  ${event.kind}  [${event.id}]  ${JSON.stringify(event.payload)}`;
}

function formatComparison(report: ContrastReport): string {
  const lines = [`${report.status.toUpperCase()}  ${report.reason}`];
  for (const [side, input] of Object.entries(report.inputs)) {
    lines.push(`  ${side}  ${input.verdict} (${input.status})  First finding  ${input.firstFinding?.property ?? "none"}`);
  }
  const difference = report.firstDifference;
  if (difference) {
    lines.push("", `First different input choice at step ${difference.step}`,
      `  left   ${difference.left ? eventLine(difference.left) : difference.leftId ?? "(end of history)"}`,
      `  right  ${difference.right ? eventLine(difference.right) : difference.rightId ?? "(end of history)"}`);
  } else {
    lines.push("The recorded choices match.");
  }
  lines.push(`Controlled pairs tried: ${report.attempts} / ${report.maxPairs}`);
  const isolated = report.isolated;
  if (isolated) {
    lines.push("", `Controlled swap after ${isolated.prefix.length} shared choices`,
      `  A  ${eventLine(isolated.actions.leftFirst)}`, `  B  ${eventLine(isolated.actions.rightFirst)}`,
      isolated.control);
    for (const [order, arm] of [["A then B", isolated.left], ["B then A", isolated.right]] as const) {
      const { summary } = arm;
      lines.push("", `${order}  ${summary.verdict} (${summary.status})`,
        `  Compared event     ${eventLine(arm.targetEvent ?? arm.counterpartEvent)}`,
        `  Last caller input or signal delivered by then  ${eventLine(arm.lastDelivery)}`,
        `  Provider holds  ${summary.bookings.map(b => b.bookingId + " on " + b.day).join(", ") || "no booking"}`,
        `  Device played   ${summary.played.map(mark => mark.day).join(", ") || "no confirmation"}`);
      if (summary.firstFinding) lines.push(`  First finding   ${summary.firstFinding.property} [${summary.firstFinding.eventId}]`);
    }
  }
  return lines.join("\n");
}

export async function compareCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: {
      adapter: { type: "string" }, "left-adapter": { type: "string" }, "right-adapter": { type: "string" },
      observation: { type: "string" }, "max-pairs": { type: "string" }, "out-dir": { type: "string" }, json: { type: "boolean" },
    },
  });
  const [leftPath, rightPath] = positionals;
  if (positionals.length !== 2 || !leftPath?.trim() || !rightPath?.trim()) {
    throw new Error("Usage: turntrace compare <left.json> <right.json>");
  }
  for (const flag of ["adapter", "left-adapter", "right-adapter", "out-dir"] as const) checkPath(flag, values[flag]);
  if (values.adapter && (values["left-adapter"] || values["right-adapter"])) {
    throw new Error("Choose --adapter for a shared module or supply side-specific adapter paths.");
  }
  if (values.observation !== undefined && !values.observation.trim()) throw new Error("--observation requires a name.");
  const maxPairs = integer("max-pairs", values["max-pairs"], 64);
  const left = await verifyInput("Left", leftPath, values["left-adapter"] ?? values.adapter);
  const right = await verifyInput("Right", rightPath, values["right-adapter"] ?? values.adapter);
  const { report, pair } = contrastLabTraces(left.trace, right.trace, left.adapter, {
    maxPairs, ...(values.observation === undefined ? {} : { observation: values.observation }),
  });
  const directory = values["out-dir"];
  if (directory) {
    mkdirSync(directory);
    if (pair) {
      saveTrace(join(directory, "left.json"), pair.left);
      saveTrace(join(directory, "right.json"), pair.right);
    }
    saveTrace(join(directory, "comparison.json"), report);
  }
  console.log(values.json ? JSON.stringify(report) : formatComparison(report));
  if (directory && !values.json) console.log(`Saved comparison to ${directory}`);
  return report.status === "inconclusive" ? 3 : 0;
}
