import { randomUUID } from "node:crypto";
import { closeSync, linkSync, openSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

export async function readJson(path: string): Promise<unknown> {
  const content = await readFile(path, "utf8");
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid or incomplete JSON in ${path}: ${error instanceof Error ? error.message : error}`);
  }
}

export function saveTrace(path: string, trace: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = openSync(temporary, "wx");
  try {
    try {
      writeFileSync(file, JSON.stringify(trace, null, 2) + "\n", "utf8");
    } finally {
      closeSync(file);
    }
    // Publish the complete file atomically, including when two exports choose the same name.
    linkSync(temporary, path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(`Trace already exists at ${path}. Choose a new filename.`);
    }
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
}
