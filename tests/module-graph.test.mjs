import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const LIB_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "gemini",
  "scripts",
  "lib"
);

// A cycle between two lib modules loads fine from one side and throws
// "Cannot access X before initialization" from the other, so whether it breaks depends on
// which module the entry point imports first. Importing each one on its own is what
// catches that; importing the CLI only ever exercises one order.
test("every lib module loads on its own", async () => {
  const modules = fs
    .readdirSync(LIB_DIR)
    .filter((name) => name.endsWith(".mjs"))
    .sort();

  assert.ok(modules.length > 5, "found the lib directory");

  for (const name of modules) {
    await assert.doesNotReject(
      () => import(path.join(LIB_DIR, name)),
      `${name} must load without depending on another module being imported first`
    );
  }
});
