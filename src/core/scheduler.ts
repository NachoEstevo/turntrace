export type Action = {
  readonly id: string;
  readonly tick: number;
  readonly parents: readonly string[];
  readonly run: () => void;
};

function validId(id: string): boolean {
  return typeof id === "string" && id.length > 0 && !/[^\x21-\x7e]/u.test(id);
}

/** Validate initial actions and each new batch before selecting the next step. */
function validateGraph(actions: ReadonlyMap<string, Action>): void {
  const children = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  const ready: string[] = [];

  for (const action of actions.values()) {
    remaining.set(action.id, action.parents.length);
    if (!action.parents.length) ready.push(action.id);
    for (const id of action.parents) {
      const parent = actions.get(id);
      if (!parent) throw new Error(`Missing parent "${id}" of "${action.id}"`);
      if (parent.tick > action.tick) {
        throw new Error(`"${action.id}" at tick ${action.tick} precedes parent "${id}" at tick ${parent.tick}`);
      }
      const dependents = children.get(id);
      if (dependents) dependents.push(action.id);
      else children.set(id, [action.id]);
    }
  }

  // Kahn's algorithm also finds cycles disconnected from otherwise runnable actions.
  for (let index = 0; index < ready.length; index++) {
    for (const child of children.get(ready[index]!) ?? []) {
      const count = remaining.get(child)! - 1;
      remaining.set(child, count);
      if (count === 0) ready.push(child);
    }
  }
  if (ready.length !== actions.size) {
    const blocked = [...remaining].filter(([, count]) => count > 0).map(([id]) => id);
    throw new Error(`Dependency cycle blocks: ${blocked.sort().join(", ")}`);
  }
}

export class Scheduler {
  private readonly actions = new Map<string, Action>();
  private readonly pending = new Map<string, Action>();
  private phase: "setup" | "running" | "finished" = "setup";
  private now = 0;

  constructor(private readonly maxSteps = 1_000) {
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 0) {
      throw new Error("maxSteps must be a nonnegative safe integer");
    }
  }

  schedule(action: Action): void {
    if (this.phase === "finished") throw new Error("Schedule already finished");
    if (!validId(action.id)) throw new Error("Action ID must contain printable ASCII without spaces");
    if (this.actions.has(action.id)) throw new Error(`Duplicate action ID "${action.id}"`);
    if (!Number.isSafeInteger(action.tick) || action.tick < this.now) {
      throw new Error(`Invalid tick for "${action.id}": expected a safe integer >= ${this.now}`);
    }
    if (action.parents.some((id) => !validId(id)) || new Set(action.parents).size !== action.parents.length) {
      throw new Error(`Invalid or duplicate parent ID for "${action.id}"`);
    }
    const registered = { ...action, parents: [...action.parents] };
    this.actions.set(action.id, registered);
    this.pending.set(action.id, registered);
  }

  /** Run one fresh world. A replay selects the actual action at every step. */
  run(preferredIds: readonly string[] = [], replayChoices?: readonly string[]): readonly string[] {
    if (this.phase !== "setup") throw new Error("Each scheduler can run only once");
    this.phase = "running";
    const ranks = new Map(preferredIds.map((id, index) => [id, index]));
    const choices: string[] = [];
    let validatedSize = 0;
    try {
      while (this.pending.size > 0) {
        if (validatedSize !== this.actions.size) {
          validateGraph(this.actions);
          validatedSize = this.actions.size;
        }
        const step = choices.length + 1;
        if (choices.length === this.maxSteps) {
          throw new Error(`Step limit ${this.maxSteps} reached before step ${step}`);
        }
        const enabled = [...this.pending.values()].filter((action) =>
          action.parents.every((id) => !this.pending.has(id)),
        );
        const earliestTick = enabled.reduce((tick, action) => Math.min(tick, action.tick), Infinity);
        const candidates = enabled.filter((action) => action.tick === earliestTick);
        candidates.sort((a, b) => {
          const rankA = ranks.get(a.id) ?? Infinity;
          const rankB = ranks.get(b.id) ?? Infinity;
          if (rankA !== rankB) return rankA - rankB;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });

        const selected = replayChoices === undefined
          ? candidates[0]
          : candidates.find((action) => action.id === replayChoices[choices.length]);
        if (!selected) {
          const requested = replayChoices?.[choices.length] ?? "<missing>";
          const available = candidates.map((action) => action.id).join(", ");
          throw new Error(`Replay diverged at step ${step}: "${requested}" is not enabled (available: ${available})`);
        }
        this.now = selected.tick;
        this.pending.delete(selected.id);
        choices.push(selected.id);
        selected.run();
      }
      if (replayChoices !== undefined && choices.length !== replayChoices.length) {
        throw new Error(`Replay diverged at step ${choices.length + 1}: extra choice after the terminal step`);
      }
      return choices;
    } finally {
      this.phase = "finished";
    }
  }
}
