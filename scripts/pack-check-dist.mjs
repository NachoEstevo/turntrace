import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";

function filesUnder(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix + entry.name;
    if (entry.isDirectory()) return filesUnder(join(directory, entry.name), path + "/");
    assert(entry.isFile(), "Unexpected non-file: " + join(directory, entry.name));
    return [path];
  });
}

// A renamed or removed TypeScript module can leave a stale compiled file behind.
// Reject that tree before npm archives it. A developer's files stay untouched.
const expected = filesUnder("src").filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))
  .flatMap((name) => [name.slice(0, -3) + ".js", name.slice(0, -3) + ".d.ts"]);
assert.deepEqual(filesUnder("dist").sort(), expected.sort(), "dist must match the compiled public source tree");
