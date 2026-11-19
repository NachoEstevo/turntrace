import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const cli = fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));

function run(...args: string[]) {
  const command = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  if (command.error) throw command.error;
  return command;
}

it("compares durable recovery and an explicit handoff against independent provider and playback facts", () => {
  const output = run("recovery");
  expect(output.status).toBe(0);
  expect(output.stdout).toContain("PASS  safe / idempotent");
  expect(output.stdout).toContain("PASS  safe / opaque");
  expect(output.stdout.match(/Provider holds 1 booking/g)).toHaveLength(2);
  expect(output.stdout).toMatch(/Agent outcome\s+confirmed \(receipt /);
  expect(output.stdout).toMatch(/Agent outcome\s+unknown \(human review /);
  expect(output.stdout).toMatch(/Device played\s+no confirmation/);
  expect(output.stdout).toMatch(/store\.commit[\s\S]+store\.ack[\s\S]+request\.1[\s\S]+provider\.1[\s\S]+reply\.drop[\s\S]+agent\.crash[\s\S]+agent\.restart/);
});

it("reports duplicate bookings under the blind retry for both provider modes", () => {
  const output = run("recovery", "--policy", "blind-retry");
  expect(output.status).toBe(1);
  expect(output.stdout).toContain("FAIL  blind-retry / idempotent");
  expect(output.stdout).toContain("FAIL  blind-retry / opaque");
  expect(output.stdout.match(/Provider holds 2 bookings/g)).toHaveLength(2);
  expect(output.stdout).toMatch(/FAIL [\w.-]+ \[/);
});

it.each([
  { provider: "opaque", policy: "safe", exit: 0 },
  { provider: "idempotent", policy: "safe", exit: 0 },
  { provider: "opaque", policy: "blind-retry", exit: 1 },
])("exports every observation and replays the same $policy / $provider result", async ({ provider, policy, exit }) => {
  const directory = await mkdtemp(join(tmpdir(), "turntrace recovery "));
  try {
    const path = join(directory, "case.json");
    const options = policy === "safe" ? [] : ["--policy", policy];
    const exported = run("recovery", "--provider", provider, ...options, "--out", path);
    expect(exported.status).toBe(exit);
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved.schemaVersion).toBe(2);
    const lines = exported.stdout.split(/\r?\n/).filter((line) => /^\s+t\d+\s/.test(line));
    expect(lines.map((line) => line.trim().split(/\s+/)[1])).toEqual(saved.events.map((event: { id: string }) => event.id));
    const replay = run("replay", path);
    expect(replay.status).toBe(exit);
    const report = exported.stdout.slice(0, exported.stdout.indexOf("Saved trace to")).trimEnd();
    expect(replay.stdout.trimEnd()).toBe(`Verified replay of ${saved.choices.length} choices.\n\n${report}`);

    const collision = run("recovery", "--provider", provider, "--out", path);
    expect(collision.status).toBe(2);
    expect(collision.stderr).toMatch(/trace already exists/i);
    expect(await readdir(directory)).toEqual(["case.json"]);

    saved.events[0].payload.day = "Tuesday";
    await writeFile(path, JSON.stringify(saved));
    const edited = run("replay", path);
    expect(edited.status).toBe(2);
    expect(edited.stderr).toMatch(/event 1/i);
    expect(edited.stdout).toBe("");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("documents the recovery command and rejects ambiguous exports or unknown options", () => {
  expect(run("recovery", "--help").stdout).toContain("turntrace recovery [--provider idempotent|opaque]");
  for (const args of [["--provider", "maybe"], ["--policy", "maybe"], ["--out", "ambiguous.json"], ["some-input"]]) {
    const error = run("recovery", ...args);
    expect(error.status).toBe(2);
    expect(error.stderr).not.toBe("");
    expect(error.stdout).toBe("");
  }
});
