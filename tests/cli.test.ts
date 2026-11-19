import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const cli = fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));
const example = fileURLToPath(new URL("../examples/commit-first.buggy.json", import.meta.url));

function run(...args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

it("compares the four cases and identifies the first unsupported claim", () => {
  const result = run("demo");
  expect(result.status).toBe(1);
  expect(result.stdout).toMatch(/commit-first\s+buggy\s+Thursday\s+Thursday\s+Tuesday\s+FAIL/);
  expect(result.stdout.match(/\bPASS\b/g)).toHaveLength(3);
  expect(result.stdout).toContain("claim.supported [agent.confirm]");
});

it("regenerates the checked-in trace byte for byte and reproduces its failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "turntrace example "));
  try {
    const path = join(directory, "booking.json");
    const exported = run("demo", "--order", "commit-first", "--policy", "buggy", "--out", path);
    expect(exported.status).toBe(1);
    expect(await readFile(path, "utf8")).toBe(await readFile(example, "utf8"));
    const replay = run("replay", example);
    expect(replay.status).toBe(1);
    expect(replay.stdout).toMatch(/Verified replay of \d+ choices/);
    expect(replay.stdout).toContain("Active bookings: booking-1 on Tuesday");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("replays the repair and returns a distinct error for edited evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "turntrace replay "));
  try {
    const path = join(directory, "booking.json");
    const exported = run("demo", "--order", "commit-first", "--policy", "fixed", "--out", path);
    expect(exported.status).toBe(0);
    const replay = run("replay", path);
    expect(replay.status).toBe(0);
    expect(replay.stdout).toContain("Active bookings: booking-1 on Thursday");

    const trace = JSON.parse(await readFile(path, "utf8"));
    trace.result.verdict = "fail";
    await writeFile(path, JSON.stringify(trace));
    const edited = run("replay", path);
    expect(edited.status).toBe(2);
    expect(edited.stderr).toMatch(/recorded result differs/i);
    expect(edited.stdout).toBe("");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("explains usage and rejects ambiguous exports", () => {
  expect(run("--help").stdout).toContain("turntrace replay <trace.json>");
  const ambiguous = run("demo", "--out", "ambiguous.json");
  expect(ambiguous.status).toBe(2);
  expect(ambiguous.stderr).toContain("single case");
  expect(run("replay").status).toBe(2);
});
