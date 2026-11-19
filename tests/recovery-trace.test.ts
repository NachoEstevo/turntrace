import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson, createRecoveryTrace, replayRecoveryTrace, replayTrace } from "../src/index.js";

function withFreshDigest<T extends { digest: string }>(trace: T): T {
  const { digest: _previous, ...body } = trace;
  return { ...trace, digest: createHash("sha256").update(canonicalJson(body)).digest("hex") };
}

describe("recovery trace replay", () => {
  for (const policy of ["safe", "blind-retry"] as const) {
    for (const provider of ["idempotent", "opaque"] as const) {
      it(`recreates ${policy} / ${provider} from its recorded choices`, () => {
        const original = createRecoveryTrace(policy, provider);
        const fromDisk: unknown = JSON.parse(JSON.stringify(original));
        expect(replayTrace(fromDisk)).toEqual(original);
        expect(replayRecoveryTrace(fromDisk).digest).toBe(original.digest);
        expect(createRecoveryTrace(policy, provider).digest).toBe(original.digest);
      });
    }
  }

  it("rejects impossible, incomplete and extra choices after a fresh digest", () => {
    const trace = createRecoveryTrace("safe", "idempotent");
    for (const choices of [
      ["unknown.event", ...trace.choices.slice(1)],
      trace.choices.slice(0, -1),
      [...trace.choices, "extra.event"],
    ]) {
      expect(() => replayTrace(withFreshDigest({ ...trace, choices }))).toThrow(/step [0-9]+/i);
    }
  });

  it("recomputes observations, mode and verdict when the stored digest is coherent", () => {
    const safe = createRecoveryTrace("safe", "opaque");
    const blind = createRecoveryTrace("blind-retry", "opaque");
    const events = [...safe.events];
    [events[0], events[1]] = [events[1]!, events[0]!];
    expect(() => replayTrace(withFreshDigest({ ...safe, events }))).toThrow(/event 1 /);
    expect(() => replayTrace(withFreshDigest({ ...safe, result: blind.result }))).toThrow(/recomputed checks/);
    expect(() => replayTrace(withFreshDigest({ ...safe, scenario: { ...safe.scenario, policy: "blind-retry" } })))
      .toThrow(/diverged/i);
    expect(() => replayTrace(withFreshDigest({ ...safe, scenario: { ...safe.scenario, provider: "idempotent" } })))
      .toThrow(/diverged/i);
  });

  it("rejects unknown versions, mismatching fixture identity, extra fields and old digests", () => {
    const trace = createRecoveryTrace("safe", "idempotent");
    for (const change of [
      { schemaVersion: 1 },
      { schemaVersion: 3 },
      { schemaVersion: "2" },
      { manifest: { ...trace.manifest, fixture: "booking-correction/1" } },
      { manifest: { ...trace.manifest, implementationSha256: "0".repeat(64) } },
      { scenario: { ...trace.scenario, operationKey: "another-key" } },
      { result: { ...trace.result, ["__proto__"]: { added: true } } },
    ]) {
      expect(() => replayTrace(withFreshDigest({ ...trace, ...change }))).toThrow();
    }
    expect(() => replayTrace({ ...trace, digest: "0".repeat(64) })).toThrow(/digest mismatch/);
    expect(() => replayTrace(null)).toThrow(/schemaVersion/);
  });

  it("opens the historical trace with the version dispatcher", () => {
    const saved = JSON.parse(readFileSync(new URL("../examples/commit-first.buggy.json", import.meta.url), "utf8"));
    expect(replayTrace(saved)).toEqual(saved);
    expect(() => replayRecoveryTrace(saved)).toThrow(/schemaVersion/);
  });

  it("replays both checked-in examples with the compiled public package", () => {
    const program = `
      import assert from "node:assert/strict";
      import { readFileSync } from "node:fs";
      import { createRecoveryTrace, replayTrace } from "turntrace";
      const read = name => JSON.parse(readFileSync("examples/" + name, "utf8"));
      const legacy = read("commit-first.buggy.json");
      const recovery = read("recovery.idempotent.json");
      assert.deepStrictEqual(replayTrace(legacy), legacy);
      assert.deepStrictEqual(replayTrace(recovery), recovery);
      assert.deepStrictEqual(createRecoveryTrace("safe", "idempotent"), recovery);
    `;
    execFileSync(process.execPath, ["--input-type=module", "-e", program], {
      cwd: new URL("../", import.meta.url),
      stdio: "pipe",
    });
  });
});
