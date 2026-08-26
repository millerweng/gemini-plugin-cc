import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { ownsPluginDataDir, resolveStateDir } from "../plugins/gemini/scripts/lib/state.mjs";
import { makeTempDir } from "./helpers.mjs";

const FALLBACK_ROOT = path.join(os.tmpdir(), "gemini-companion");

function withPluginData(value, fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  if (value === null) {
    delete process.env.CLAUDE_PLUGIN_DATA;
  } else {
    process.env.CLAUDE_PLUGIN_DATA = value;
  }
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
}

test("recognises this plugin's own data directories", () => {
  for (const name of ["gemini", "gemini-inline", "gemini-gemini-plugin-cc", "Gemini.something"]) {
    assert.equal(ownsPluginDataDir(path.join("/somewhere", name)), true, name);
  }
});

// Regression: CLAUDE_PLUGIN_DATA can point at the Codex plugin's directory. Codex uses
// the same state/<slug>-<hash>/broker.json layout, so trusting it made this client dial
// the Codex app-server and fail every task on `session/new`.
test("rejects another plugin's data directory", () => {
  for (const name of ["codex-inline", "codex", "claude-mem-thedotmack", "geminix"]) {
    assert.equal(ownsPluginDataDir(path.join("/somewhere", name)), false, name);
  }
});

test("resolveStateDir uses the plugin data dir when it belongs to Gemini", () => {
  const workspace = makeTempDir("state-owner-");
  const pluginData = path.join(makeTempDir("plugin-data-"), "gemini-inline");

  const resolved = withPluginData(pluginData, () => resolveStateDir(workspace));
  assert.ok(
    resolved.startsWith(path.join(pluginData, "state")),
    `expected ${resolved} under ${pluginData}`
  );
});

test("resolveStateDir falls back to tmp when the data dir belongs to another plugin", () => {
  const workspace = makeTempDir("state-foreign-");
  const foreign = path.join(makeTempDir("plugin-data-"), "codex-inline");

  const resolved = withPluginData(foreign, () => resolveStateDir(workspace));
  assert.ok(resolved.startsWith(FALLBACK_ROOT), `expected ${resolved} under ${FALLBACK_ROOT}`);
  assert.ok(!resolved.includes("codex-inline"));
});

test("the same workspace still resolves to one directory per owner", () => {
  const workspace = makeTempDir("state-stable-");
  const pluginData = path.join(makeTempDir("plugin-data-"), "gemini");

  const first = withPluginData(pluginData, () => resolveStateDir(workspace));
  const second = withPluginData(pluginData, () => resolveStateDir(workspace));
  assert.equal(first, second);
});
