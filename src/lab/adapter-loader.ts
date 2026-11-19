import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { canonicalJson } from "../trace.js";
import { parseAgentAdapter, type AgentAdapter, type Scenario } from "./contract.js";
import { builtinPolicy } from "./policy.js";

export type AdapterIdentity = {
  kind: "builtin" | "local";
  id: string;
  version: string;
  sha256: string;
  runtime: string | null;
  lockfileSha256: string | null;
};
export type LabAdapter = { manifest: AdapterIdentity; implementation: AgentAdapter };

type Graph = {
  entry: string;
  modules: Record<string, { source: string; imports: Record<string, string> }>;
  lockfileSha256: string | null;
};

const build = new URL("../../dist/lab/", import.meta.url);
const run = promisify(execFile);
const evaluated = new Map<string, Promise<AgentAdapter>>();
let policyDigest: string | undefined;

export function builtinLabAdapter(id: string): LabAdapter {
  const implementation = parseAgentAdapter(builtinPolicy(id));
  policyDigest ??= createHash("sha256").update(readFileSync(new URL("policy.js", build))).digest("hex");
  return { implementation, manifest: {
    kind: "builtin", id: implementation.id, version: implementation.version, sha256: policyDigest,
    runtime: null, lockfileSha256: null,
  } };
}

async function loadCaptured(graph: Graph, sha256: string): Promise<AgentAdapter> {
  const prefix = `turntrace-local:${sha256}/`;
  const hook = new URL("adapter-hooks.js", build);
  hook.searchParams.set("graph", sha256);
  register(hook, { data: { prefix, modules: graph.modules } });
  const loaded = await import(prefix + graph.entry);
  return parseAgentAdapter(loaded.default);
}

/** Read and fingerprint the complete static graph before evaluating any adapter code. */
export async function loadLabAdapter(
  scenario: Scenario, trustedPath?: string, expected?: AdapterIdentity,
): Promise<LabAdapter> {
  if (trustedPath === undefined) {
    if (expected?.kind === "local") throw new Error("Replay requires the trusted local adapter supplied with --adapter");
    const builtin = builtinLabAdapter(scenario.policy);
    if (expected && canonicalJson(builtin.manifest) !== canonicalJson(expected)) {
      throw new Error("Incompatible built-in adapter fingerprint");
    }
    return builtin;
  }
  if (expected && expected.kind !== "local") throw new Error("Recorded trace uses a built-in adapter");

  const { stdout } = await run(process.execPath, [
    "--no-warnings", "--experimental-vm-modules", fileURLToPath(new URL("adapter-graph.js", build)), trustedPath,
  ], { encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  const graph: Graph = JSON.parse(stdout);
  const runtime = process.version;
  const sha256 = createHash("sha256").update(canonicalJson({ ...graph, runtime })).digest("hex");
  const { lockfileSha256 } = graph;
  if (expected && (expected.sha256 !== sha256 || expected.runtime !== runtime ||
      expected.lockfileSha256 !== lockfileSha256 || expected.id !== scenario.policy)) {
    throw new Error("Incompatible local adapter graph, lockfile, runtime or policy ID");
  }

  let promise = evaluated.get(sha256);
  if (!promise) {
    promise = loadCaptured(graph, sha256);
    evaluated.set(sha256, promise);
  }
  const implementation = await promise;
  if (implementation.id !== scenario.policy || (expected && expected.version !== implementation.version)) {
    throw new Error("Incompatible local adapter ID or version");
  }
  return { implementation, manifest: {
    kind: "local", id: implementation.id, version: implementation.version, sha256, runtime, lockfileSha256,
  } };
}
