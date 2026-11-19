import { replayLabTrace, runLabTrace, type LabAdapter, type LabTrace } from "./trace.js";

export interface OrderContrastPair {
  prefix: string[];
  /** Left dispatches A, B; right dispatches B, A. */
  actions: [string, string];
  left: LabTrace;
  right: LabTrace;
}

export type OrderContrastSearch = {
  attempts: number;
  nonReversiblePairs: number;
  nonterminalPairs: number;
} & (
  | { status: "isolated"; pair: OrderContrastPair }
  | { status: "exhausted" | "not-isolated"; pair?: never }
);

type Candidate = { path: readonly string[]; at: number; a: string; b: string };
type IndexedTrace = { trace: LabTrace; positions: ReadonlyMap<string, number> };

function indexTrace(trace: LabTrace): IndexedTrace {
  return { trace, positions: new Map(trace.choices.map((id, i) => [id, i])) };
}

/** Only inspect alternatives to an action actually selected at this recorded prefix. */
function* inversions(source: IndexedTrace, other: IndexedTrace, at: number, sourceIsLeft: boolean): Generator<Candidate> {
  const chosen = source.trace.choices[at];
  if (chosen === undefined) return;
  const otherChosenIndex = other.positions.get(chosen);
  if (otherChosenIndex === undefined) return;
  for (const alternative of source.trace.alternatives[at]!) {
    const here = source.positions.get(alternative);
    const there = other.positions.get(alternative);
    if (here === undefined || here <= at || there === undefined || there >= otherChosenIndex) continue;
    yield {
      path: source.trace.choices, at,
      a: sourceIsLeft ? chosen : alternative,
      b: sourceIsLeft ? alternative : chosen,
    };
  }
}

function* candidates(left: LabTrace, right: LabTrace): Generator<Candidate> {
  const l = indexTrace(left);
  const r = indexTrace(right);
  const length = Math.min(left.choices.length, right.choices.length);
  let fork = 0;
  while (fork < length && left.choices[fork] === right.choices[fork]) fork++;
  if (fork === length) return; // No two common actions appear in opposite orders.

  // Try the direct disagreement at the last identical prefix before scanning
  // other recorded prefixes. Earlier identical steps cannot exhibit an inversion.
  const a = left.choices[fork]!;
  const b = right.choices[fork]!;
  const direct = l.positions.has(b) && r.positions.has(a) &&
    left.alternatives[fork]!.includes(b) && right.alternatives[fork]!.includes(a);
  if (direct) yield { path: left.choices, at: fork, a, b };

  for (const probe of [inversions(l, r, fork, true), inversions(r, l, fork, false)]) {
    for (const candidate of probe) {
      // The direct pair is the only pair these two frontier scans can share.
      if (!direct || candidate.a !== a || candidate.b !== b) yield candidate;
    }
  }
  for (let at = Math.max(left.choices.length, right.choices.length) - 1; at > fork; at--) {
    yield* inversions(l, r, at, true);
    yield* inversions(r, l, at, false);
  }
}

type Arm = { status: "terminal"; trace: LabTrace } | { status: "nonreversible" | "nonterminal" };

function arm(source: LabTrace, adapter: LabAdapter, prefix: string[], first: string, second: string): Arm {
  const run = runLabTrace(source.scenario, adapter, {
    limits: source.options.limits, prefix: [...prefix, first], preferredChoices: [second],
  });
  // The preference cannot select a disabled action. If it wins immediately,
  // its unique ID is consumed and the entire tail follows the standard ASCII tie-break.
  if (!run.alternatives[prefix.length]?.includes(second)) return { status: "nonreversible" };
  const next = run.choices[prefix.length + 1];
  if (next !== undefined && next !== second) return { status: "nonreversible" };
  if (run.status !== "terminal") return { status: "nonterminal" };
  return next === second ? { status: "terminal", trace: run } : { status: "nonreversible" };
}

/**
 * Both inputs must already have been verified against the same scenario, adapter
 * and run limits. Search original inversions at recorded prefixes, not arbitrary
 * new histories. The budget counts candidate pairs, including unsuccessful probes.
 * Count an observed disagreement with adjacency once per pair; otherwise a blocked
 * or truncated arm counts as nonterminal. Terminal pairs may also miss the target.
 */
export function findOrderContrast(
  left: LabTrace, right: LabTrace, adapter: LabAdapter,
  targetMatches: (leftArm: LabTrace, rightArm: LabTrace) => boolean,
  maxPairs: number,
): OrderContrastSearch {
  if (!Number.isSafeInteger(maxPairs) || maxPairs < 0) throw new Error("maxPairs must be a nonnegative safe integer");
  const counts = { attempts: 0, nonReversiblePairs: 0, nonterminalPairs: 0 };
  for (const { path, at, a, b } of candidates(left, right)) {
    if (counts.attempts === maxPairs) return { ...counts, status: "exhausted" };
    counts.attempts++;
    const prefix = path.slice(0, at);
    const leftArm = arm(left, adapter, prefix, a, b);
    const rightArm = arm(right, adapter, prefix, b, a);
    if (leftArm.status === "nonreversible" || rightArm.status === "nonreversible") {
      counts.nonReversiblePairs++;
      continue;
    }
    if (leftArm.status !== "terminal" || rightArm.status !== "terminal") {
      counts.nonterminalPairs++;
      continue;
    }
    if (!targetMatches(leftArm.trace, rightArm.trace)) continue;
    return {
      ...counts, status: "isolated",
      pair: { prefix, actions: [a, b], left: replayLabTrace(leftArm.trace, adapter), right: replayLabTrace(rightArm.trace, adapter) },
    };
  }
  return { ...counts, status: "not-isolated" };
}
