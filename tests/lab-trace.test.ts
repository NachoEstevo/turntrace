import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { canonicalJson, loadLabAdapter, parseScenario, replayLabTrace, replayTrace, runLabTrace } from "../src/index.js";
import { initialize, resolve as resolveCaptured } from "../src/lab/adapter-hooks.js";

const scenario = parseScenario({
  schemaVersion: 1, id: "tie", provider: { idempotent: true, query: true, amend: true },
  expectation: "settled", delivery: "recoverable",
  actions: [
    { id: "first", kind: "input", inputId: "caller-1", day: "Tuesday", tick: 1 },
    { id: "second", kind: "input", inputId: "caller-2", day: "Thursday", tick: 1 },
  ],
});

function withFreshDigest<T extends { digest: string }>(trace: T): T {
  const { digest: _previous, ...body } = trace;
  return { ...trace, digest: createHash("sha256").update(canonicalJson(body)).digest("hex") };
}

it("replays actual legal choices for a non-default history and bounded prefix", async () => {
  const adapter = await loadLabAdapter(scenario);
  const first = runLabTrace(scenario, adapter);
  const race = first.alternatives.findIndex(ids => ids.length > 1);
  expect(race).toBeGreaterThanOrEqual(0);
  const different = first.alternatives[race]!.find(id => id !== first.choices[race]);
  const prefix = [...first.choices.slice(0, race), different!];
  const alternate = runLabTrace(scenario, adapter, { prefix, seed: 21 });
  expect(alternate.choices.slice(0, prefix.length)).toEqual(prefix);
  expect(replayTrace(JSON.parse(JSON.stringify(alternate)))).toEqual(alternate);
  for (const maxSteps of [0, 1]) {
    const cut = runLabTrace(scenario, adapter, { limits: { maxSteps } });
    expect(cut.status).toBe("truncated");
    expect(cut.choices).toHaveLength(maxSteps);
    expect(replayLabTrace(cut)).toEqual(cut);
  }
});

it("rejects forged observations, enabled sets, results, identities and extra keys even after rehashing", async () => {
  const trace = runLabTrace(scenario, await loadLabAdapter(scenario));
  for (const edit of [
    { choices: ["missing", ...trace.choices.slice(1)] },
    { choices: trace.choices.slice(0, -1) },
    { choices: [...trace.choices, "extra"] },
    { alternatives: [[], ...trace.alternatives.slice(1)] },
    { events: trace.events.slice(1) },
    { result: { ...trace.result, findings: [{ forged: true }] } },
    { reason: "forged" },
    { scenario: { ...trace.scenario, id: "edited" } },
    { manifest: { ...trace.manifest, implementationSha256: "0".repeat(64) } },
    { manifest: { ...trace.manifest, adapter: { ...trace.manifest.adapter, path: "arbitrary.mjs" } } },
    { result: { ...trace.result, ["__proto__"]: { edited: true } } },
  ]) {
    expect(() => replayLabTrace(withFreshDigest({ ...trace, ...edit }))).toThrow();
  }
});

it("checks the captured transitive graph and lockfile before evaluating an edited adapter", async () => {
  // Native Node runs the compiled loader hooks. The test runner has its own ESM resolver.
  const native = createRequire(import.meta.url)("../dist/index.js") as typeof import("../src/index.js");
  const local = { ...scenario, policy: "customer" };
  const directory = await mkdtemp(join(tmpdir(), "turntrace adapter "));
  const entry = join(directory, "entry.mjs");
  const helper = join(directory, "helper.mjs");
  const lock = join(directory, "package-lock.json");
  const implementation = 'export const version = "1";';
  try {
    await writeFile(entry, `import { version } from "./helper.mjs";
      export default { id: "customer", version, init() { return {}; },
        step(next) { return { next, commands: [] }; } };`);
    await writeFile(helper, implementation);
    await writeFile(lock, "{}");
    const handle = await native.loadLabAdapter(local, entry);
    const trace = native.runLabTrace(local, handle);
    expect(handle.manifest.runtime).toBe(process.version);
    const match = await native.loadReplayLabAdapter(trace, entry);
    expect(native.replayLabTrace(trace, match)).toEqual(trace);
    await expect(native.loadReplayLabAdapter(trace)).rejects.toThrow(/--adapter/);
    await writeFile(helper, 'throw new Error("Edited code evaluated"); export const version = "2";');
    await expect(native.loadReplayLabAdapter(trace, entry)).rejects.toThrow(/Incompatible local adapter graph/);
    expect(native.replayLabTrace(trace, handle).digest).toBe(trace.digest);
    await writeFile(helper, implementation);
    await writeFile(lock, '{"new":true}');
    await expect(native.loadReplayLabAdapter(trace, entry)).rejects.toThrow(/Incompatible local adapter graph/);
    await writeFile(entry, 'import "node:os"; throw new Error("Unexpected evaluation");');
    await expect(native.loadLabAdapter(local, entry)).rejects.toThrow(/Unsupported adapter import/);
    await writeFile(entry, 'await import("./helper.mjs");');
    await expect(native.loadLabAdapter(local, entry)).rejects.toThrow(/outside its captured static graph/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("still opens both historical traces through the version dispatcher", async () => {
  for (const name of ["commit-first.buggy.json", "recovery.idempotent.json"]) {
    const saved = JSON.parse(await readFile(new URL(`../examples/${name}`, import.meta.url), "utf8"));
    expect(replayTrace(saved)).toEqual(saved);
  }
});

it("leaves imports from a previously loaded bundle to that bundle's resolver", async () => {
  const entry = "turntrace-local:current/entry.mjs";
  initialize({ prefix: "turntrace-local:current/", modules: { "entry.mjs": { source: "", imports: {} } } });
  const context = { parentURL: "turntrace-local:earlier/entry.mjs", conditions: [], importAttributes: {} };
  const ownerResult = { url: "turntrace-local:earlier/selected.mjs", shortCircuit: true };
  expect(await resolveCaptured(entry, context, () => ownerResult)).toEqual(ownerResult);
});

it("regenerates the reduced premature-ack example and replays its first violation", async () => {
  const native = createRequire(import.meta.url)("../dist/index.js") as typeof import("../src/index.js");
  const directory = new URL("../examples/lab/", import.meta.url);
  const [source, saved] = await Promise.all(["reduce.json", "premature-ack.trace.json"].map(
    async name => JSON.parse(await readFile(new URL(name, directory), "utf8")),
  ));
  const verified = native.replayLabTrace(saved);
  expect(verified).toEqual(saved);
  expect(verified.result.findings[0]?.property).toBe("input.durable-ack");

  const original = native.parseScenario(source);
  const adapter = await native.loadLabAdapter(original);
  const run = native.runLabTrace(original, adapter, {
    limits: verified.options.limits, ...(verified.options.seed === null ? {} : { seed: verified.options.seed }),
  });
  const reduction = native.minimizeLabTrace(run, adapter);
  expect(reduction.status).toBe("irreducible");
  expect(reduction.removedPerturbations.length).toBeGreaterThan(0);
  expect(reduction.reduced).toEqual(verified);
});
