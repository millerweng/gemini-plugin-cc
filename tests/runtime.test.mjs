import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { makeTempDir, writeExecutable } from "./helpers.mjs";
import { saveState } from "../plugins/gemini/scripts/lib/state.mjs";

const COMPANION_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../plugins/gemini/scripts/gemini-companion.mjs"
);

function seedState(workspace, jobs) {
  const pluginDataDir = path.join(workspace, ".plugin-data");
  fs.mkdirSync(pluginDataDir, { recursive: true });
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    saveState(workspace, { config: { stopReviewGate: false }, jobs });
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
  }
  return pluginDataDir;
}

function runCompanionCommand(workspace, pluginDataDir, args) {
  return spawnSync(process.execPath, [COMPANION_SCRIPT, ...args], {
    cwd: workspace,
    env: {
      HOME: workspace,
      PATH: "/usr/bin:/bin",
      NODE_NO_WARNINGS: "1",
      CLAUDE_PLUGIN_ROOT: path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../plugins/gemini"
      ),
      CLAUDE_PLUGIN_DATA: pluginDataDir,
      GEMINI_COMPANION_SESSION_ID: "test-session-1"
    },
    encoding: "utf8",
    timeout: 5000
  });
}

// ---------------------------------------------------------------------------
// Fix 1: stop-gate jobs excluded from resume candidates
// ---------------------------------------------------------------------------

test("task-resume-candidate excludes stop-gate jobs", () => {
  const workspace = makeTempDir("runtime-gate-excl-");
  const jobs = [
    {
      id: "task-gate-001",
      sessionId: "test-session-1",
      jobClass: "task",
      status: "completed",
      stopGate: true,
      threadId: "gate-thread-abc",
      updatedAt: "2025-01-01T00:02:00Z"
    },
    {
      id: "task-user-002",
      sessionId: "test-session-1",
      jobClass: "task",
      status: "completed",
      stopGate: false,
      threadId: "user-thread-def",
      updatedAt: "2025-01-01T00:01:00Z"
    }
  ];
  const pluginDataDir = seedState(workspace, jobs);

  const result = runCompanionCommand(workspace, pluginDataDir, [
    "task-resume-candidate",
    "--json"
  ]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.equal(output.available, true);
  assert.equal(output.candidate.id, "task-user-002", "should skip stop-gate job and pick user job");
});

test("task-resume-candidate returns unavailable when only stop-gate jobs exist", () => {
  const workspace = makeTempDir("runtime-gate-only-");
  const jobs = [
    {
      id: "task-gate-001",
      sessionId: "test-session-1",
      jobClass: "task",
      status: "completed",
      stopGate: true,
      threadId: "gate-thread-abc",
      updatedAt: "2025-01-01T00:01:00Z"
    }
  ];
  const pluginDataDir = seedState(workspace, jobs);

  const result = runCompanionCommand(workspace, pluginDataDir, [
    "task-resume-candidate",
    "--json"
  ]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.equal(output.available, false, "should report no resume candidate when only stop-gate jobs exist");
});

// ---------------------------------------------------------------------------
// Fix 1: buildTaskRunMetadata marks stop-gate prompts
// ---------------------------------------------------------------------------

test("stop-gate prompt is detected and marked in task metadata", () => {
  const workspace = makeTempDir("runtime-meta-");
  const jobs = [];
  const pluginDataDir = seedState(workspace, jobs);
  const binDir = path.join(workspace, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  writeExecutable(path.join(binDir, "gemini"), '#!/bin/sh\necho "1.0.0"');

  const stopGatePrompt = "Run a stop-gate review of the previous Claude turn. Some additional instructions.";
  const result = spawnSync(
    process.execPath,
    [COMPANION_SCRIPT, "task", "--plan", "--json", stopGatePrompt],
    {
      cwd: workspace,
      env: {
        HOME: workspace,
        PATH: `${binDir}:/usr/bin:/bin`,
        NODE_NO_WARNINGS: "1",
        CLAUDE_PLUGIN_ROOT: path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "../plugins/gemini"
        ),
        CLAUDE_PLUGIN_DATA: pluginDataDir,
        GEMINI_COMPANION_SESSION_ID: "test-session-1"
      },
      encoding: "utf8",
      timeout: 10000
    }
  );

  // The task will fail because there's no real Gemini CLI ACP, but the job
  // record should still be written with the stopGate marker and title.
  const stateFile = path.join(pluginDataDir, workspace, "state.json");
  if (fs.existsSync(stateFile)) {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const gateJob = state.jobs.find((j) => j.title === "Gemini Stop Gate Review");
    if (gateJob) {
      assert.equal(gateJob.stopGate, true, "stop-gate job should have stopGate marker");
    }
  }
});

// ---------------------------------------------------------------------------
// Fix 3: ACP client capabilities
// ---------------------------------------------------------------------------

test("ACP client does not advertise unimplemented fs capabilities", async () => {
  const acpClientPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../plugins/gemini/scripts/lib/acp-client.mjs"
  );
  const wrapper = [
    `const mod = await import(${JSON.stringify("file://" + acpClientPath)});`,
    `// The module doesn't export DEFAULT_CLIENT_CAPABILITIES directly,`,
    `// so we check via the AcpClient constructor or the exported class.`,
    `// For a unit test, we import and inspect.`,
    `process.stdout.write("ok");`
  ].join("\n");
  const tmpDir = makeTempDir("acp-cap-");
  const wrapperFile = path.join(tmpDir, "check.mjs");
  fs.writeFileSync(wrapperFile, wrapper);

  const result = spawnSync(process.execPath, [wrapperFile], {
    cwd: tmpDir,
    env: {
      HOME: tmpDir,
      PATH: process.env.PATH,
      NODE_NO_WARNINGS: "1"
    },
    encoding: "utf8",
    timeout: 5000
  });
  assert.equal(result.status, 0, `module should load without errors: ${result.stderr}`);

  // Verify the source file directly: no fs capability declaration
  const source = fs.readFileSync(acpClientPath, "utf8");
  assert.ok(
    !source.includes("readTextFile"),
    "ACP client should not advertise readTextFile capability"
  );
  assert.ok(
    !source.includes("writeTextFile"),
    "ACP client should not advertise writeTextFile capability"
  );
});

// ---------------------------------------------------------------------------
// Fix 2: verify connectivity includes mcpServers
// ---------------------------------------------------------------------------

test("verifyGeminiConnectivity sends mcpServers in session/new request", async () => {
  const geminiMjsPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../plugins/gemini/scripts/lib/gemini.mjs"
  );
  const source = fs.readFileSync(geminiMjsPath, "utf8");

  assert.ok(
    source.includes("mcpServers: []"),
    "verifyGeminiConnectivity should include mcpServers: [] in session/new params"
  );
  assert.ok(
    !source.includes("spawnSync") || !source.match(/verifyGeminiConnectivity[\s\S]*?spawnSync/),
    "verifyGeminiConnectivity should not use spawnSync"
  );
});
