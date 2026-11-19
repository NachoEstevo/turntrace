import { isDeepStrictEqual } from "node:util";
import type { LabEvent } from "./contract.js";
import { findOrderContrast } from "./contrast-search.js";
import type { LabAdapter, LabTrace } from "./trace.js";
import type { LabFinding } from "./verify.js";

type Arms<T> = { left: T; right: T };
type Scope = "isolated" | "no-contrast" | "inconclusive";
type Safety = { verdict: LabTrace["result"]["verdict"]; firstFinding: Pick<LabFinding, "property" | "signature"> | null };
type Target =
  | ({ kind: "verdict" } & Arms<Safety>)
  | ({ kind: "observation"; name: string } & Arms<LabEvent | null>);

function summary(trace: LabTrace) {
  const { verdict, findings, bookings, played, review, reconfirm } = trace.result;
  return { digest: trace.digest, scenarioId: trace.scenario.id, policy: trace.scenario.policy,
    status: trace.status, verdict, firstFinding: findings[0] ?? null, bookings, played, review, reconfirm };
}
type Summary = ReturnType<typeof summary>;
interface ArmEvidence {
  summary: Summary;
  targetEvent: LabEvent | null;
  /** Event in this arm at the other arm's target ID, if the slot exists here. */
  counterpartEvent: LabEvent | null;
  /** Latest caller input or external signal delivered in the same epoch at or before the comparable slot. */
  lastDelivery: LabEvent | null;
}
export interface ContrastReport {
  kind: "turntrace.comparison";
  schemaVersion: 1;
  status: Scope;
  reason: string;
  attempts: number;
  maxPairs: number;
  nonReversiblePairs: number;
  nonterminalPairs: number;
  inputs: Arms<Summary>;
  firstDifference: { step: number; leftId: string | null; rightId: string | null; left: LabEvent | null; right: LabEvent | null } | null;
  target: Target;
  isolated: ({
    prefix: string[];
    actions: { leftFirst: LabEvent; rightFirst: LabEvent };
    control: string;
  } & Arms<ArmEvidence>) | null;
}
export interface LabContrast {
  report: ContrastReport;
  pair?: Arms<LabTrace>;
}

function byId(trace: LabTrace, id: string | null | undefined): LabEvent | null {
  return id ? trace.events.find(event => event.id === id) ?? null : null;
}

function firstDifference(left: LabTrace, right: LabTrace): ContrastReport["firstDifference"] {
  for (let index = 0; index < Math.max(left.choices.length, right.choices.length); index++) {
    const leftId = left.choices[index] ?? null;
    const rightId = right.choices[index] ?? null;
    if (leftId !== rightId) return { step: index + 1, leftId, rightId, left: byId(left, leftId), right: byId(right, rightId) };
  }
  return null;
}

function firstSafety(trace: LabTrace): Safety {
  const first = trace.result.findings[0];
  return { verdict: trace.result.verdict, firstFinding: first ? { property: first.property, signature: first.signature } : null };
}

function observations(trace: LabTrace, name: string): LabEvent[] {
  return trace.events.filter(event => event.actor === "agent" && event.kind === "agent.observed" && event.payload.name === name);
}

function sameSlot(a: LabEvent, b: LabEvent): boolean {
  return a.id === b.id && a.payload.epoch === b.payload.epoch && isDeepStrictEqual(a.parents, b.parents);
}

function observationMatches(candidate: LabTrace, original: LabTrace, expected: LabEvent, name: string): boolean {
  const matches = observations(candidate, name);
  const observation = matches[0];
  if (matches.length !== 1 || !observation || !sameSlot(observation, expected) ||
      !isDeepStrictEqual(observation.payload.data, expected.payload.data)) return false;
  // Require the same safety outcomes as the original lane alongside the adapter's reported data.
  const keys = (trace: LabTrace) => trace.result.findings.map(({ property, signature }) => [property, signature]);
  return candidate.result.verdict === original.result.verdict && isDeepStrictEqual(keys(candidate), keys(original));
}

function lastDelivery(trace: LabTrace, anchor: LabEvent | null): LabEvent | null {
  if (!anchor || typeof anchor.payload.epoch !== "number") return null;
  const end = trace.events.indexOf(anchor);
  const epoch = anchor.payload.epoch;
  for (let index = end; index >= 0; index--) {
    const event = trace.events[index]!;
    if (event.payload.epoch !== epoch) continue;
    if (event.kind === "input.delivered" || event.kind === "agent.signalDelivered") return event;
    if (event.kind === "agent.restarted" || event.kind === "agent.started") break;
  }
  return null;
}

function evidence(trace: LabTrace, targetEvent: LabEvent | null, opposite: LabEvent | null): ArmEvidence {
  const counterpartEvent = byId(trace, opposite?.id);
  return { summary: summary(trace), targetEvent, counterpartEvent, lastDelivery: lastDelivery(trace, targetEvent ?? counterpartEvent) };
}

/** Both input traces must already have passed replayLabTrace with their resolved adapter. */
export function contrastLabTraces(
  left: LabTrace, right: LabTrace, adapter: LabAdapter, options: { maxPairs: number; observation?: string } = { maxPairs: 64 },
): LabContrast {
  const { maxPairs, observation } = options;
  if (!Number.isSafeInteger(maxPairs) || maxPairs < 0) throw new Error("maxPairs must be a nonnegative safe integer.");
  if (observation !== undefined && (typeof observation !== "string" || !observation.trim())) {
    throw new Error("observation must be a nonempty name.");
  }
  const report: ContrastReport = {
    kind: "turntrace.comparison", schemaVersion: 1, status: "inconclusive", reason: "", attempts: 0, maxPairs,
    nonReversiblePairs: 0, nonterminalPairs: 0,
    inputs: { left: summary(left), right: summary(right) }, firstDifference: firstDifference(left, right),
    target: observation === undefined
      ? { kind: "verdict", left: firstSafety(left), right: firstSafety(right) }
      : { kind: "observation", name: observation, left: null, right: null },
    isolated: null,
  };
  function finish(status: Scope, reason: string): LabContrast {
    report.status = status;
    report.reason = reason;
    return { report };
  }
  const mismatches: string[] = [];
  if (left.manifest.scenarioSha256 !== right.manifest.scenarioSha256) mismatches.push("scenario fingerprint");
  if (left.manifest.engine !== right.manifest.engine || left.manifest.implementationSha256 !== right.manifest.implementationSha256) {
    mismatches.push("engine or implementation fingerprint");
  }
  if (!isDeepStrictEqual(left.manifest.adapter, right.manifest.adapter)) mismatches.push("traced adapter manifest");
  if (!isDeepStrictEqual(left.manifest.adapter, adapter.manifest)) mismatches.push("supplied adapter manifest");
  if (!isDeepStrictEqual(left.manifest, right.manifest) && !mismatches.length) mismatches.push("trace manifest");
  if (!isDeepStrictEqual(left.options.limits, right.options.limits)) mismatches.push("scheduler limits");
  if (mismatches.length) return finish("inconclusive", `Controlled comparison requires matching ${mismatches.join(", ")}.`);
  if (left.status !== "terminal" || right.status !== "terminal") return finish("inconclusive", "Both input traces must reach a terminal state.");

  let match: (a: LabTrace, b: LabTrace) => boolean;
  if (report.target.kind === "observation") {
    const name = report.target.name;
    const a = observations(left, name);
    const b = observations(right, name);
    report.target.left = a.length === 1 ? a[0]! : null;
    report.target.right = b.length === 1 ? b[0]! : null;
    if (!report.target.left || !report.target.right) {
      return finish("inconclusive", `Observation '${name}' must occur exactly once per input. Found ${a.length} on the left and ${b.length} on the right.`);
    }
    const expectedLeft = report.target.left;
    const expectedRight = report.target.right;
    if (!sameSlot(expectedLeft, expectedRight)) return finish("inconclusive", `Observation '${name}' has different causal slots or epochs across the inputs.`);
    if (isDeepStrictEqual(expectedLeft.payload.data, expectedRight.payload.data)) {
      return finish("no-contrast", `Both supplied inputs reported the same data for observation '${name}' at the selected slot. This comparison covers that observation only.`);
    }
    match = (a, b) => a.status === "terminal" && b.status === "terminal" &&
      observationMatches(a, left, expectedLeft, name) && observationMatches(b, right, expectedRight, name);
  } else {
    const { left: a, right: b } = report.target;
    if (isDeepStrictEqual(a, b)) {
      const label = a.firstFinding ? `the same first finding '${a.firstFinding.property}' with the same signature` : `the same ${a.verdict} verdict`;
      return finish("no-contrast", `The two supplied inputs have ${label}. This comparison covers the verdict and first finding only.`);
    }
    if (!((a.verdict === "pass" && b.verdict === "fail") || (a.verdict === "fail" && b.verdict === "pass"))) {
      return finish("inconclusive", "The input verdicts lack a passing control for the selected first failure.");
    }
    match = (candidateLeft, candidateRight) => candidateLeft.status === "terminal" && candidateRight.status === "terminal" &&
      isDeepStrictEqual(firstSafety(candidateLeft), a) && isDeepStrictEqual(firstSafety(candidateRight), b);
  }

  const search = findOrderContrast(left, right, adapter, match, maxPairs);
  report.attempts = search.attempts;
  report.nonReversiblePairs = search.nonReversiblePairs;
  report.nonterminalPairs = search.nonterminalPairs;
  const pair = search.pair;
  if (!pair) {
    const reason = search.status === "exhausted" ? "Pair budget exhausted" : "No tested adjacent swap reproduced the target";
    const omitted = search.nonReversiblePairs || search.nonterminalPairs
      ? ` Opposite adjacent orders were unavailable for ${search.nonReversiblePairs} pair(s), and ${search.nonterminalPairs} pair(s) could not reach comparable terminal runs.`
      : "";
    return finish("inconclusive", `${reason} within the candidate decisions from the two supplied traces.${omitted}`);
  }
  const targetEvent = (trace: LabTrace) => report.target.kind === "observation"
    ? observations(trace, report.target.name)[0]! : byId(trace, trace.result.findings[0]?.eventId);
  const leftTarget = targetEvent(pair.left);
  const rightTarget = targetEvent(pair.right);
  const leftFirst = byId(pair.left, pair.actions[0]);
  const rightFirst = byId(pair.right, pair.actions[1]);
  if (!leftFirst || !rightFirst) return finish("inconclusive", "A swapped scheduler action has no matching event observation.");
  report.isolated = {
    prefix: pair.prefix, actions: { leftFirst, rightFirst },
    left: evidence(pair.left, leftTarget, rightTarget), right: evidence(pair.right, rightTarget, leftTarget),
    control: "Both fresh terminal runs share a prefix, choose opposite adjacent orders, and use the same deterministic continuation rule.",
  };
  report.status = "isolated";
  report.reason = "The adjacent swap reproduced the selected target on both arms.";
  return { report, pair: { left: pair.left, right: pair.right } };
}
