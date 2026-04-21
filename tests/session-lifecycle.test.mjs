import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import { saveState, loadState } from "../plugins/gemini/scripts/lib/state.mjs";
import { buildStatusSnapshot, resolveWaitTargetJob } from "../plugins/gemini/scripts/lib/job-control.mjs";

process.env.__GEMINI_HOOK_IMPORT_ONLY = "1";
const { cleanupSessionJobs } = await import("../plugins/gemini/scripts/session-lifecycle-hook.mjs");

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

function loadStateWithPlugin(workspace, pluginDataDir) {
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    return loadState(workspace);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
  }
}

test("cleanupSessionJobs preserves completed jobs from the same session", () => {
  const workspace = makeTempDir("lifecycle-");
  const sessionId = "session-abc";
  const jobs = [
    { id: "job-1", sessionId, status: "completed", updatedAt: "2025-01-01T00:00:00Z" },
    { id: "job-2", sessionId, status: "failed", updatedAt: "2025-01-01T00:01:00Z" },
    { id: "job-3", sessionId, status: "running", pid: 999999, updatedAt: "2025-01-01T00:02:00Z" }
  ];
  const pluginDataDir = seedState(workspace, jobs);

  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    cleanupSessionJobs(workspace, sessionId);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
  }

  const state = loadStateWithPlugin(workspace, pluginDataDir);
  const remainingIds = state.jobs.map((j) => j.id);
  assert.ok(remainingIds.includes("job-1"), "completed job should survive");
  assert.ok(remainingIds.includes("job-2"), "failed job should survive");
  assert.ok(!remainingIds.includes("job-3"), "running job should be removed");
});

test("cleanupSessionJobs does not touch jobs from other sessions", () => {
  const workspace = makeTempDir("lifecycle-other-");
  const jobs = [
    { id: "job-mine", sessionId: "session-A", status: "running", pid: 999998, updatedAt: "2025-01-01T00:00:00Z" },
    { id: "job-other", sessionId: "session-B", status: "running", pid: 999997, updatedAt: "2025-01-01T00:00:00Z" }
  ];
  const pluginDataDir = seedState(workspace, jobs);

  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    cleanupSessionJobs(workspace, "session-A");
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
  }

  const state = loadStateWithPlugin(workspace, pluginDataDir);
  const remainingIds = state.jobs.map((j) => j.id);
  assert.ok(!remainingIds.includes("job-mine"), "active job from target session removed");
  assert.ok(remainingIds.includes("job-other"), "job from other session untouched");
});

test("buildStatusSnapshot with all:true returns cross-session jobs", () => {
  const workspace = makeTempDir("status-all-");
  const jobs = [
    { id: "job-s1", sessionId: "session-1", status: "completed", updatedAt: "2025-01-01T00:01:00Z" },
    { id: "job-s2", sessionId: "session-2", status: "completed", updatedAt: "2025-01-01T00:02:00Z" }
  ];
  const pluginDataDir = seedState(workspace, jobs);

  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const snapshot = buildStatusSnapshot(workspace, {
      all: true,
      env: { GEMINI_COMPANION_SESSION_ID: "session-1" }
    });
    const allIds = [
      ...snapshot.running.map((j) => j.id),
      ...(snapshot.latestFinished ? [snapshot.latestFinished.id] : []),
      ...snapshot.recent.map((j) => j.id)
    ];
    assert.ok(allIds.includes("job-s1"), "job from session-1 present");
    assert.ok(allIds.includes("job-s2"), "job from session-2 present with --all");
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
  }
});

test("resolveWaitTargetJob with all:true finds jobs from any session", () => {
  const workspace = makeTempDir("wait-all-");
  const jobs = [
    { id: "job-other-session", sessionId: "session-2", status: "running", pid: 999999, updatedAt: "2025-01-01T00:01:00Z" }
  ];
  const pluginDataDir = seedState(workspace, jobs);

  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const result = resolveWaitTargetJob(workspace, {
      all: true,
      env: { GEMINI_COMPANION_SESSION_ID: "session-1" }
    });
    assert.equal(result.job.id, "job-other-session");
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
  }
});

test("resolveWaitTargetJob without all filters to current session", () => {
  const workspace = makeTempDir("wait-session-");
  const jobs = [
    { id: "job-mine", sessionId: "session-1", status: "running", pid: 999999, updatedAt: "2025-01-01T00:01:00Z" },
    { id: "job-other", sessionId: "session-2", status: "running", pid: 999998, updatedAt: "2025-01-01T00:02:00Z" }
  ];
  const pluginDataDir = seedState(workspace, jobs);

  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const result = resolveWaitTargetJob(workspace, {
      env: { GEMINI_COMPANION_SESSION_ID: "session-1" }
    });
    assert.equal(result.job.id, "job-mine");
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
  }
});

test("resolveWaitTargetJob throws with --all hint when no session jobs active", () => {
  const workspace = makeTempDir("wait-empty-");
  const jobs = [
    { id: "job-other", sessionId: "session-2", status: "running", pid: 999999, updatedAt: "2025-01-01T00:01:00Z" }
  ];
  const pluginDataDir = seedState(workspace, jobs);

  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    assert.throws(
      () => resolveWaitTargetJob(workspace, {
        env: { GEMINI_COMPANION_SESSION_ID: "session-1" }
      }),
      /--all/
    );
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
  }
});
