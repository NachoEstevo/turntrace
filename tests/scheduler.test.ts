import { describe, expect, it, vi } from "vitest";
import { Scheduler, type Action } from "../src/core/scheduler.js";

function action(id: string, tick = 0, parents: string[] = [], run: () => void = () => {}): Action {
  return { id, tick, parents, run };
}

describe("causal scheduling", () => {
  it("breaks ties by ASCII ID and waits for both parents at the earliest eligible tick", () => {
    const scheduler = new Scheduler();
    scheduler.schedule(action("2.join", 2, ["z", "A"]));
    scheduler.schedule(action("z", 2));
    scheduler.schedule(action("after", 3));
    scheduler.schedule(action("A", 2));
    expect(scheduler.run(["2.join", "after"])).toEqual(["A", "z", "2.join", "after"]);
  });

  it("applies a preference to a dynamically scheduled same-tick child", () => {
    const simulation = () => {
      const scheduler = new Scheduler();
      scheduler.schedule(action("a.start", 1, [], () => {
        scheduler.schedule(action("z.child", 1, ["a.start"]));
      }));
      scheduler.schedule(action("b.other", 1));
      return scheduler;
    };
    const actual = simulation().run(["z.child"]);
    expect(actual).toEqual(["a.start", "z.child", "b.other"]);
    expect(simulation().run([], actual)).toEqual(actual);
    expect(simulation().run()).toEqual(["a.start", "b.other", "z.child"]);
  });

  it.each([
    { actions: [action("a", 2, ["missing"])], error: /missing parent/i },
    { actions: [action("a", 0, ["late"]), action("late", 2)], error: /precedes parent/i },
    { actions: [action("a", 1, ["b"]), action("b", 1, ["a"])], error: /cycle/i },
    { actions: [action("a", 1, ["a"])], error: /cycle/i },
  ])("rejects a malformed graph before taking an independent runnable action", ({ actions, error }) => {
    const scheduler = new Scheduler();
    const observed = vi.fn();
    scheduler.schedule(action("independent", 0, [], observed));
    for (const item of actions) scheduler.schedule(item);
    expect(() => scheduler.run()).toThrow(error);
    expect(observed).not.toHaveBeenCalled();
  });

  it.each([
    action("", 0), action("non ASCII é"), action("newline\n"), action("spaces forbidden"),
    action("x", -1), action("x", 1.5), action("x", Number.MAX_SAFE_INTEGER + 1),
    action("x", 0, [""]), action("x", 0, ["parent", "parent"]),
  ])("rejects invalid action metadata", (invalid) => {
    expect(() => new Scheduler().schedule(invalid)).toThrow();
  });

  it("rejects reused IDs, even after their original action has executed", () => {
    const scheduler = new Scheduler();
    scheduler.schedule(action("again", 0, [], () => scheduler.schedule(action("again"))));
    expect(() => scheduler.run()).toThrow(/duplicate action/i);
  });

  it("never allows a callback to move virtual time backwards", () => {
    const scheduler = new Scheduler();
    scheduler.schedule(action("now", 4, [], () => scheduler.schedule(action("past", 3))));
    expect(() => scheduler.run()).toThrow(/invalid tick/i);
  });

  it("bounds same-tick self-generated chains", () => {
    const scheduler = new Scheduler(2);
    let calls = 0;
    const again = () => {
      calls++;
      scheduler.schedule(action(`next${calls}`, 0, [], again));
    };
    scheduler.schedule(action("first", 0, [], again));
    expect(() => scheduler.run()).toThrow(/limit 2 reached before step 3/i);
    expect(calls).toBe(2);
  });
});

describe("recorded choices", () => {
  it.each([
    { choices: ["child"], step: 1 },
    { choices: ["future"], step: 1 },
    { choices: ["start", "start"], step: 2 },
    { choices: ["start", "child"], step: 3 },
    { choices: ["start", "child", "future", "extra"], step: 4 },
  ])("rejects illegal, missing or trailing choices at the first affected step", ({ choices, step }) => {
    const scheduler = new Scheduler();
    scheduler.schedule(action("start"));
    scheduler.schedule(action("child", 0, ["start"]));
    scheduler.schedule(action("future", 3));
    expect(() => scheduler.run([], choices)).toThrow(new RegExp(`step ${step}:`));
  });

  it("accepts a legal recorded order over a different current preference", () => {
    const scheduler = new Scheduler();
    scheduler.schedule(action("x"));
    scheduler.schedule(action("y"));
    expect(scheduler.run(["x"], ["y", "x"])).toEqual(["y", "x"]);
  });
});
