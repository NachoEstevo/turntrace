import { createHash } from "node:crypto";

export interface LabAction {
  id: string;
  /** Earliest release tick. A channel can admit an action later. */
  tick: number;
  parents: readonly string[];
  run: () => void;
  enabled?: () => boolean;
  resource?: "restart" | "duplicate";
}

export interface LabLimits {
  maxSteps: number;
  maxDecisions: number;
  maxRestarts: number;
  maxDuplicates: number;
}

export const defaultLabLimits: Readonly<LabLimits> = Object.freeze({
  maxSteps: 1_000, maxDecisions: 100, maxRestarts: 8, maxDuplicates: 16,
});

export interface LabRunOptions {
  limits?: Partial<LabLimits>;
  prefix?: readonly string[];
  replayChoices?: readonly string[];
  preferredChoices?: readonly string[];
  seed?: number;
}

export interface LabRun {
  choices: string[];
  alternatives: string[][];
  status: "terminal" | "blocked" | "truncated";
  reason?: string;
}

function checkNumber(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative safe integer`);
}

function runLimits(overrides: Partial<LabLimits> = {}): LabLimits {
  const limits = { ...defaultLabLimits, ...overrides };
  for (const [name, value] of Object.entries(limits)) checkNumber(name, value);
  return limits;
}

function validId(id: string): boolean {
  return typeof id === "string" && id.length > 0 && !/[^\x21-\x7e]/u.test(id);
}

type CausalAction = Pick<LabAction, "id" | "tick" | "parents">;

/** Older validated actions cannot depend on IDs first registered in this batch. */
export function validateDependencies(batch: readonly CausalAction[], all: ReadonlyMap<string, CausalAction>): void {
  const unmet = new Map(batch.map(({ id }) => [id, 0]));
  const children = new Map<string, string[]>();
  for (const action of batch) {
    for (const id of action.parents) {
      const parent = all.get(id);
      if (!parent) throw new Error(`Missing parent "${id}" of "${action.id}"`);
      if (parent.tick > action.tick) throw new Error(`Release tick of "${action.id}" precedes parent "${id}"`);
      if (!unmet.has(id)) continue;
      unmet.set(action.id, unmet.get(action.id)! + 1);
      if (!children.has(id)) children.set(id, []);
      children.get(id)!.push(action.id);
    }
  }
  const ready = [...unmet.keys()].filter((id) => unmet.get(id) === 0);
  for (let index = 0; index < ready.length; index++) {
    for (const child of children.get(ready[index]!) ?? []) {
      const count = unmet.get(child)! - 1;
      unmet.set(child, count);
      if (count === 0) ready.push(child);
    }
  }
  if (ready.length !== batch.length) throw new Error("Dependency cycle in scheduled actions");
}

function select(ids: string[], ranks: ReadonlyMap<string, number>, seed: number | undefined, step: number): string {
  let preferred: string | undefined;
  for (const id of ids) {
    const rank = ranks.get(id);
    if (rank !== undefined && (!preferred || rank < ranks.get(preferred)!)) preferred = id;
  }
  if (preferred) return preferred;
  if (seed === undefined || ids.length === 1) return ids[0]!;
  // Hash decimal safe integers without platform-specific PRNGs or 32-bit seed truncation.
  const value = createHash("sha256").update(`${seed}/${step}`).digest().readUInt32BE(0);
  return ids[value % ids.length]!;
}

export class LabScheduler {
  private readonly all = new Map<string, LabAction>();
  private readonly pending = new Map<string, LabAction>();
  private additions: LabAction[] = [];
  private phase: "setup" | "running" | "finished" = "setup";
  private now = 0;

  get tick(): number { return this.now; }

  schedule(action: LabAction): void {
    if (this.phase === "finished") throw new Error("Schedule already finished");
    if (!validId(action.id)) throw new Error("Action ID must be printable ASCII without spaces");
    if (this.all.has(action.id)) throw new Error(`Duplicate action ID "${action.id}"`);
    checkNumber(`Tick of "${action.id}"`, action.tick);
    if (action.tick < this.now) throw new Error(`Action "${action.id}" scheduled in the past at tick ${action.tick}`);
    if (action.parents.some((id) => !validId(id)) || new Set(action.parents).size !== action.parents.length) {
      throw new Error(`Invalid or duplicate parent ID for "${action.id}"`);
    }
    if (action.resource !== undefined && action.resource !== "restart" && action.resource !== "duplicate") {
      throw new Error(`Unknown resource for "${action.id}"`);
    }
    const entry = { ...action, parents: [...action.parents] };
    this.all.set(entry.id, entry);
    this.pending.set(entry.id, entry);
    this.additions.push(entry);
  }

  run(options: LabRunOptions = {}): LabRun {
    if (this.phase !== "setup") throw new Error("Each scheduler can run only once");
    const { replayChoices, prefix, seed, preferredChoices = [] } = options;
    if (prefix !== undefined && replayChoices !== undefined) throw new Error("Specify either prefix or exact replay choices");
    const required = replayChoices ?? prefix ?? [];
    if (seed !== undefined) checkNumber("seed", seed);
    const limits = runLimits(options.limits);
    const remaining = { restart: limits.maxRestarts, duplicate: limits.maxDuplicates };
    const ranks = new Map(preferredChoices.map((id, i) => [id, i]));
    const choices: string[] = [];
    const alternatives: string[][] = [];
    let decisions = 0;
    const finish = (status: LabRun["status"], reason?: string): LabRun => {
      if (required.length > choices.length) {
        throw new Error(`Choice diverged at step ${choices.length + 1}: extra action after ${status} run`);
      }
      return reason === undefined ? { choices, alternatives, status } : { choices, alternatives, status, reason };
    };

    this.phase = "running";
    try {
      while (this.pending.size) {
        if (this.additions.length) {
          validateDependencies(this.additions, this.all);
          this.additions = [];
        }
        const eligible = [...this.pending.values()].filter((action) =>
          action.parents.every((id) => !this.pending.has(id)) && (action.enabled?.() ?? true),
        );
        if (!eligible.length) {
          return finish("blocked", `No enabled delivery. Pending actions: ${[...this.pending.keys()].sort().join(", ")}`);
        }
        if (choices.length >= limits.maxSteps) return finish("truncated", "maxSteps exhausted");
        const earliest = eligible.reduce((value, action) => Math.min(value, Math.max(this.now, action.tick)), Infinity);
        const due = eligible.filter((action) => action.tick <= earliest);
        // Stop at the frontier: executing a peer could disable the unaffordable
        // action and make unexamined behavior appear fully explored.
        const exhausted = due.filter(({ resource }) => resource && remaining[resource] === 0);
        if (exhausted.length) {
          const caps = new Set(exhausted.map(({ resource }) => resource === "restart" ? "maxRestarts" : "maxDuplicates"));
          return finish("truncated", `${[...caps].sort().join(" and ")} exhausted`);
        }
        const ids = due.map(({ id }) => id).sort();
        if (ids.length > 1 && decisions >= limits.maxDecisions) return finish("truncated", "maxDecisions exhausted");
        const step = choices.length + 1;
        const explicit = replayChoices !== undefined || choices.length < required.length;
        const id = explicit ? required[choices.length] : select(ids, ranks, seed, step);
        if (id === undefined || !ids.includes(id)) {
          throw new Error(`Choice diverged at step ${step}: expected one of ${ids.join(", ")}, got ${id ?? "<missing>"}`);
        }
        const selected = this.pending.get(id)!;
        this.now = earliest;
        this.pending.delete(id);
        decisions += Number(ids.length > 1);
        if (selected.resource) remaining[selected.resource]--;
        alternatives.push(ids);
        choices.push(id);
        selected.run();
      }
      return finish("terminal");
    } finally {
      this.phase = "finished";
    }
  }
}

export interface LabExploreOptions {
  maxRuns?: number;
  limits?: Partial<LabLimits>;
  /** Sampling uses successive safe-integer seeds, wrapping after MAX_SAFE_INTEGER. */
  seed?: number;
  samples?: number;
}

export interface LabExploration<T extends LabRun> {
  runs: T[];
  counts: Record<LabRun["status"], number>;
  mode: "exhaustive" | "sampled";
  pendingPrefixes: number;
  remainingSamples: number;
  complete: boolean;
}

/** runFresh constructs every actor and a new scheduler before applying its prefix. */
export function exploreLab<T extends LabRun>(
  runFresh: (options: LabRunOptions) => T, options: LabExploreOptions = {},
): LabExploration<T> {
  const { maxRuns = 200, seed } = options;
  checkNumber("maxRuns", maxRuns);
  if (seed !== undefined) checkNumber("seed", seed);
  if (options.samples !== undefined && seed === undefined) throw new Error("samples requires a seed");
  const samples = options.samples ?? 1;
  checkNumber("samples", samples);
  const limits = runLimits(options.limits);
  const counts = { terminal: 0, blocked: 0, truncated: 0 };
  const runs: T[] = [];
  if (seed !== undefined) {
    let nextSeed = seed;
    while (runs.length < Math.min(samples, maxRuns)) {
      const run = runFresh({ limits, seed: nextSeed });
      runs.push(run);
      counts[run.status]++;
      nextSeed = nextSeed === Number.MAX_SAFE_INTEGER ? 0 : nextSeed + 1;
    }
    return { runs, counts, mode: "sampled", pendingPrefixes: 0, remainingSamples: samples - runs.length, complete: false };
  }
  // Siblings share the already executed path. Materialize only the prefix that
  // will run next, including when a wide frontier is cut short by maxRuns.
  const pending: ({ path: readonly string[]; at: number; alternative: string } | null)[] = [null];
  while (pending.length && runs.length < maxRuns) {
    const branch = pending.pop();
    const prefix = branch ? [...branch.path.slice(0, branch.at), branch.alternative] : [];
    const run = runFresh({ limits, prefix });
    runs.push(run);
    counts[run.status]++;
    // Push shallow siblings first. Popping then visits the deepest remaining
    // sibling, in ASCII order, without rerunning the already selected branch.
    for (let i = prefix.length; i < run.choices.length; i++) {
      const ids = run.alternatives[i]!;
      for (let j = ids.length - 1; j >= 0; j--) {
        const alternative = ids[j]!;
        if (alternative !== run.choices[i]) pending.push({ path: run.choices, at: i, alternative });
      }
    }
  }
  return {
    runs, counts, mode: "exhaustive", pendingPrefixes: pending.length, remainingSamples: 0,
    complete: !pending.length && counts.blocked === 0 && counts.truncated === 0,
  };
}
