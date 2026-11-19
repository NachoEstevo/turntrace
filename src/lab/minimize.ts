import type { ScenarioAction } from "./contract.js";
import { replayLabTrace, runLabTrace, type LabAdapter, type LabTrace } from "./trace.js";

export interface MinimizationResult {
  status: "irreducible" | "exhausted" | "inconclusive";
  attempts: number;
  maxAttempts: number;
  maxMilliseconds: number | null;
  elapsedMilliseconds: number | null;
  exhaustedBy: "attempts" | "time" | null;
  inconclusiveAttempts: number;
  inconclusiveReasons: string[];
  target: { property: string; signature: string };
  removedPerturbations: string[];
  original: LabTrace;
  reduced: LabTrace;
}

// A required descendant makes its optional ancestor indispensable. Every
// other descendant disappears with its parent, including members of other groups.
function* reductions(actions: readonly ScenarioAction[]): Generator<ScenarioAction[]> {
  const children = new Map<string, ScenarioAction[]>();
  const groups = new Map<string, ScenarioAction[]>();
  const optional = actions.filter(action => action.optional);
  for (const action of actions) {
    for (const id of action.parents) {
      if (!children.has(id)) children.set(id, []);
      children.get(id)!.push(action);
    }
    if (action.optional && action.group) {
      if (!groups.has(action.group)) groups.set(action.group, []);
      groups.get(action.group)!.push(action);
    }
  }

  for (const roots of [...groups.values(), ...optional.map(action => [action])]) {
    const pending = [...roots];
    const removed = new Set<string>();
    let legal = true;
    while (pending.length) {
      const action = pending.pop()!;
      if (!action.optional) {
        legal = false;
        break;
      }
      if (removed.has(action.id)) continue;
      removed.add(action.id);
      for (const child of children.get(action.id) ?? []) pending.push(child);
    }
    if (legal) yield actions.filter(action => !removed.has(action.id));
  }
}

/** Delete optional groups or actions while preserving the original first failure. */
export function minimizeLabTrace(
  value: unknown, adapter: LabAdapter, { maxAttempts = 100, maxMilliseconds }: {
    maxAttempts?: number; maxMilliseconds?: number;
  } = {},
): MinimizationResult {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 0) {
    throw new Error("maxAttempts must be a nonnegative safe integer");
  }
  if (maxMilliseconds !== undefined && (!Number.isSafeInteger(maxMilliseconds) || maxMilliseconds < 0)) {
    throw new Error("maxMilliseconds must be a nonnegative safe integer");
  }
  const started = maxMilliseconds === undefined ? null : performance.now();
  const original = replayLabTrace(value, adapter);
  const first = original.result.findings[0];
  if (!first) throw new Error("Minimization requires a verified trace with a property violation.");
  const target = { property: first.property, signature: first.signature };
  let reduced = original;
  let attempts = 0;
  let inconclusiveAttempts = 0;
  const reasons = new Set<string>();
  // Each candidate uses the same original ordering preference. That makes a
  // repeated retained-ID set the same experiment regardless of the parent.
  const rejected = new Map<string, "different" | "inconclusive">();
  const options = {
    limits: original.options.limits,
    preferredChoices: original.choices,
    ...(original.options.seed === null ? {} : { seed: original.options.seed }),
  };

  function finish(
    status: MinimizationResult["status"], exhaustedBy: MinimizationResult["exhaustedBy"] = null,
  ): MinimizationResult {
    const kept = new Set(reduced.scenario.actions.map(action => action.id));
    const removedPerturbations = original.scenario.actions.filter(action => !kept.has(action.id)).map(action => action.id);
    return {
      status, exhaustedBy, attempts, maxAttempts, maxMilliseconds: maxMilliseconds ?? null,
      elapsedMilliseconds: started === null ? null : performance.now() - started,
      inconclusiveAttempts, inconclusiveReasons: [...reasons], target, removedPerturbations, original, reduced,
    };
  }

  for (;;) {
    let improved = false;
    let inconclusiveNeighbor = false;
    for (const actions of reductions(reduced.scenario.actions)) {
      const key = JSON.stringify(actions.map(action => action.id));
      const prior = rejected.get(key);
      if (prior) {
        if (prior === "inconclusive") inconclusiveNeighbor = true;
        continue;
      }
      if (started !== null && maxMilliseconds !== undefined && performance.now() - started >= maxMilliseconds) {
        return finish("exhausted", "time");
      }
      if (attempts >= maxAttempts) return finish("exhausted", "attempts");
      attempts++;
      try {
        const candidate = runLabTrace({ ...original.scenario, actions }, adapter, options);
        const failure = candidate.result.findings[0];
        // A safety violation witnessed on a prefix is established even if a
        // step bound or blocked channel prevents subsequent progress checks.
        if (failure?.property === target.property && failure.signature === target.signature) {
          reduced = replayLabTrace(candidate, adapter);
          improved = true;
          break;
        }
        if (candidate.status === "terminal") {
          rejected.set(key, "different");
          continue;
        }
        reasons.add(candidate.reason ?? candidate.status);
      } catch (error) {
        reasons.add(error instanceof Error ? error.message : String(error));
      }
      rejected.set(key, "inconclusive");
      inconclusiveNeighbor = true;
      inconclusiveAttempts++;
    }
    // Restart from the new best case after every success. A previously
    // necessary perturbation can become removable once another one is gone.
    if (!improved) return finish(inconclusiveNeighbor ? "inconclusive" : "irreducible");
  }
}
