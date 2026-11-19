import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SourceTextModule } from "node:vm";

// This helper runs under Node's VM modules flag to parse static import requests.
// It never links or evaluates the files. Only the caller-supplied entry selects a root.
const entry = realpathSync(process.argv[2]!);
if (extname(entry) !== ".mjs") throw new Error("Trusted adapter entry must be an .mjs file");
const root = dirname(entry);
const files = new Map<string, { source: string; imports: Record<string, string> }>();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function visit(path: string): string {
  const actual = realpathSync(path);
  const key = relative(root, actual).split(sep).join("/");
  if (isAbsolute(key) || key.startsWith("../") || key === ".." || extname(key) !== ".mjs") {
    throw new Error("Adapter module must be an .mjs file inside the entry directory");
  }
  if (files.has(key)) return key;
  const source = decoder.decode(readFileSync(actual));
  const module = new SourceTextModule(source, { identifier: key });
  const imports: Record<string, string> = Object.create(null);
  files.set(key, { source, imports });
  for (const request of module.dependencySpecifiers) {
    if (!(request.startsWith("./") || request.startsWith("../")) || request.includes("\\")) {
      throw new Error(`Unsupported adapter import "${request}" in ${key}; use relative .mjs files`);
    }
    const target = new URL(request, pathToFileURL(actual));
    if (target.search || target.hash || extname(fileURLToPath(target)) !== ".mjs") {
      throw new Error(`Unsupported adapter import "${request}" in ${key}; use a relative .mjs filename`);
    }
    imports[request] = visit(fileURLToPath(target));
  }
  return key;
}

visit(entry);
let lockfileSha256: string | null = null;
for (let directory = root; ; directory = dirname(directory)) {
  const lock = join(directory, "package-lock.json");
  if (existsSync(lock)) {
    lockfileSha256 = createHash("sha256").update(readFileSync(lock)).digest("hex");
    break;
  }
  if (dirname(directory) === directory) break;
}
process.stdout.write(JSON.stringify({ entry: basename(entry), modules: Object.fromEntries(files), lockfileSha256 }));
