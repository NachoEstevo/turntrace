import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, createTrace, replayTrace } from "../src/trace.js";
import type { Order, Policy } from "../src/fixtures/booking/index.js";

function withFreshDigest<T extends { digest: string }>(trace: T): T {
  const { digest: _previous, ...body } = trace;
  return { ...trace, digest: createHash("sha256").update(canonicalJson(body)).digest("hex") };
}

describe("trace replay", () => {
  const policies: Policy[] = ["buggy", "fixed"];
  const orders: Order[] = ["correction-first", "commit-first"];
  for (const policy of policies) {
    for (const order of orders) {
      it(`recreates ${policy} / ${order} from JSON`, () => {
        const trace = createTrace(policy, order);
        const reordered = Object.fromEntries(Object.entries(trace).reverse());
        expect(replayTrace(JSON.parse(JSON.stringify(reordered)))).toEqual(trace);
        expect(createTrace(policy, order).digest).toBe(trace.digest);
      });
    }
  }

  it("compares every observation even when the edited trace has a fresh digest", () => {
    const trace = createTrace("buggy", "commit-first");
    const events = [...trace.events];
    const [first, second] = events;
    events[0] = second!;
    events[1] = first!;
    expect(() => replayTrace(withFreshDigest({ ...trace, events }))).toThrow(/event 1 /);
    expect(() => replayTrace(withFreshDigest({ ...trace, events: trace.events.slice(0, -1) })))
      .toThrow(/recorded observation differs/);
  });

  it("rejects a declared result copied from a passing run, even if re-hashed", () => {
    const trace = createTrace("buggy", "commit-first");
    const healthy = createTrace("fixed", "commit-first");
    expect(() => replayTrace(withFreshDigest({ ...trace, result: healthy.result })))
      .toThrow(/recorded result differs/);
  });

  it("rejects disabled, missing and extra choices at the divergent step", () => {
    const trace = createTrace("fixed", "commit-first");
    for (const choices of [
      ["does.not.exist", ...trace.choices.slice(1)],
      trace.choices.slice(0, -1),
      [...trace.choices, "after.end"],
    ]) {
      expect(() => replayTrace(withFreshDigest({ ...trace, choices }))).toThrow(/step [0-9]+/i);
    }
  });

  it("rejects legal choices from a different named order", () => {
    const trace = createTrace("buggy", "commit-first");
    const scenario = { ...trace.scenario, order: "correction-first" };
    expect(() => replayTrace(withFreshDigest({ ...trace, scenario }))).toThrow(/schedule "correction-first"/);
  });

  it("executes the declared policy when reproducing decisions", () => {
    const trace = createTrace("buggy", "commit-first");
    const scenario = { ...trace.scenario, policy: "fixed" };
    expect(() => replayTrace(withFreshDigest({ ...trace, scenario }))).toThrow(/diverged/i);
  });

  it("rejects unknown fields and incompatible versions or build identities", () => {
    const trace = createTrace("fixed", "correction-first");
    for (const change of [
      { schemaVersion: 2 },
      { url: "an-unexpected-field" },
      { manifest: { ...trace.manifest, fixture: "another-fixture" } },
      { manifest: { ...trace.manifest, implementationSha256: "0".repeat(64) } },
      { scenario: { ...trace.scenario, initialDay: "Friday" } },
      { result: { ...trace.result, invented: true } },
    ]) {
      expect(() => replayTrace(withFreshDigest({ ...trace, ...change }))).toThrow();
    }
    expect(() => replayTrace({ ...trace, digest: "f".repeat(64) })).toThrow(/digest mismatch/);
    const injected = { ...trace.result, ["__proto__"]: { added: true } };
    expect(() => replayTrace({ ...trace, result: injected })).toThrow();
  });

  it("serializes sorted object keys and preserves array order", () => {
    expect(canonicalJson({ choices: ["b", "a"], "2": "two", "10": "ten" }))
      .toBe('{"10":"ten","2":"two","choices":["b","a"]}');
    expect(() => canonicalJson({ day: undefined })).toThrow(/JSON/);
  });
});
