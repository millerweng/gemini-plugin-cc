import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import { saveState, resolveStateDir } from "../plugins/gemini/scripts/lib/state.mjs";

const HOOK_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../plugins/gemini/scripts/stop-review-gate-hook.mjs"
);

function runHook(workspace, { gateEnabled = false, geminiAvailable = false } = {}) {
  const pluginDataDir = path.join(workspace, ".plugin-data");
  fs.mkdirSync(pluginDataDir, { recursive: true });

  const origEnv = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    saveState(workspace, { config: { stopReviewGate: gateEnabled }, jobs: [] });
  } finally {
    if (origEnv === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = origEnv;
  }

  const binDir = path.join(workspace, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  if (geminiAvailable) {
    const script = '#!/bin/sh\necho "1.0.0"';
    const binPath = path.join(binDir, "gemini");
    fs.writeFileSync(binPath, script);
    fs.chmodSync(binPath, 0o755);
  }

  const hookInput = JSON.stringify({ cwd: workspace });

  const envPath = geminiAvailable
    ? `${binDir}:${process.env.PATH}`
    : "/usr/bin:/bin";

  const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
    cwd: workspace,
    input: hookInput,
    env: {
      HOME: workspace,
      PATH: envPath,
      NODE_NO_WARNINGS: "1",
      CLAUDE_PLUGIN_ROOT: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugins/gemini"),
      CLAUDE_PLUGIN_DATA: pluginDataDir
    },
    encoding: "utf8",
    timeout: 5000
  });

  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    status: result.status
  };
}

test("review gate disabled: hook passes through silently", () => {
  const workspace = makeTempDir("gate-off-");
  const { stdout, status } = runHook(workspace, { gateEnabled: false });
  assert.equal(status, 0);
  assert.equal(stdout, "");
});

test("review gate enabled + gemini unavailable: hook blocks with setup message", () => {
  const workspace = makeTempDir("gate-no-gemini-");
  const { stdout, status } = runHook(workspace, { gateEnabled: true, geminiAvailable: false });
  assert.equal(status, 0);
  const decision = JSON.parse(stdout);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /not set up|not found/i);
});
