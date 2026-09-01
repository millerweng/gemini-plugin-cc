import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { makeTempDir } from "./helpers.mjs";
import { enrichJob } from "../plugins/gemini/scripts/lib/job-control.mjs";
import { renderJobStatusReport } from "../plugins/gemini/scripts/lib/render.mjs";

function writeLog(dir, name, ageMs = 0) {
  const logFile = path.join(dir, name);
  fs.writeFileSync(logFile, `[${new Date().toISOString()}] Reasoning: looking at git.mjs\n`, "utf8");
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(logFile, when, when);
  }
  return logFile;
}

// A pid that has certainly been released: spawn something trivial and let it exit.
function deadPid() {
  const child = spawnSync(process.execPath, ["-e", ""]);
  return child.pid;
}

function runningJob(overrides) {
  return {
    id: "gem-1",
    status: "running",
    jobClass: "review",
    kindLabel: "review",
    title: "Gemini Review",
    phase: "reviewing",
    startedAt: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
    pid: process.pid,
    ...overrides
  };
}

test("a growing log reports the run as alive", () => {
  const dir = makeTempDir("liveness-live-");
  const job = enrichJob(runningJob({ logFile: writeLog(dir, "job.log") }));

  assert.equal(job.stalled, false);
  assert.equal(job.processAlive, true);
  assert.ok(job.lastUpdate, "lastUpdate is reported");
  assert.match(renderJobStatusReport(job), /Liveness: the log is still growing/);
});

// `updatedAt` is only stamped when the phase changes, and a long single-phase review
// never changes phase. The log mtime is what has to win.
test("log activity outranks a stale updatedAt", () => {
  const dir = makeTempDir("liveness-mtime-");
  const job = enrichJob(
    runningJob({
      logFile: writeLog(dir, "job.log"),
      updatedAt: new Date(Date.now() - 45 * 60 * 1000).toISOString()
    })
  );

  assert.equal(job.stalled, false, "a fresh log means the run is moving, whatever updatedAt says");
});

test("a silent log past the threshold is reported as possibly stuck", () => {
  const dir = makeTempDir("liveness-stall-");
  const job = enrichJob(runningJob({ logFile: writeLog(dir, "job.log", 9 * 60 * 1000) }));

  assert.equal(job.stalled, true);
  assert.equal(job.processAlive, true);
  assert.match(renderJobStatusReport(job), /Liveness: nothing new in the log for .* may be stuck/);
});

test("a running job whose process is gone is reported as dead, not running", () => {
  const dir = makeTempDir("liveness-dead-");
  const job = enrichJob(
    runningJob({ logFile: writeLog(dir, "job.log", 20 * 60 * 1000), pid: deadPid() })
  );

  assert.equal(job.processAlive, false);
  const output = renderJobStatusReport(job);
  assert.match(output, /died without writing a result/);
  // The stall warning would understate it — a dead process is not "may be stuck".
  assert.doesNotMatch(output, /may be stuck/);
});

// Elapsed climbs from startedAt regardless, so it can never be the liveness signal.
test("elapsed alone does not separate a live run from a dead one", () => {
  const dir = makeTempDir("liveness-elapsed-");
  const live = enrichJob(runningJob({ logFile: writeLog(dir, "live.log") }));
  const dead = enrichJob(
    runningJob({ logFile: writeLog(dir, "dead.log", 20 * 60 * 1000), pid: deadPid() })
  );

  assert.equal(live.elapsed, dead.elapsed, "both report the same elapsed time");
  assert.notEqual(live.processAlive, dead.processAlive, "liveness is what tells them apart");
});

test("a finished job carries no liveness fields", () => {
  const dir = makeTempDir("liveness-done-");
  const job = enrichJob(
    runningJob({
      status: "completed",
      completedAt: new Date().toISOString(),
      logFile: writeLog(dir, "job.log", 60 * 60 * 1000),
      pid: deadPid()
    })
  );

  assert.equal(job.lastUpdate, null);
  assert.equal(job.processAlive, null);
  assert.equal(job.stalled, false);
  assert.doesNotMatch(renderJobStatusReport(job), /Liveness:/);
});

// A job record written before the pid field existed must not be called dead.
test("a missing pid reads as unknown rather than dead", () => {
  const dir = makeTempDir("liveness-nopid-");
  const job = enrichJob(runningJob({ logFile: writeLog(dir, "job.log"), pid: undefined }));

  assert.equal(job.processAlive, null);
  assert.doesNotMatch(renderJobStatusReport(job), /died without writing a result/);
});

// Status and Elapsed read identically for all three, so the table needs its own cell.
test("the active jobs table separates alive, quiet, and dead runs", async () => {
  const { renderStatusReport } = await import("../plugins/gemini/scripts/lib/render.mjs");
  const dir = makeTempDir("liveness-table-");
  const running = [
    enrichJob(runningJob({ id: "gem-live", logFile: writeLog(dir, "live.log") })),
    enrichJob(runningJob({ id: "gem-quiet", logFile: writeLog(dir, "quiet.log", 11 * 60 * 1000) })),
    enrichJob(
      runningJob({ id: "gem-dead", logFile: writeLog(dir, "dead.log", 26 * 60 * 1000), pid: deadPid() })
    )
  ];

  const output = renderStatusReport({
    sessionRuntime: { label: "direct startup" },
    config: { stopReviewGate: false },
    running,
    latestFinished: null,
    recent: []
  });

  assert.match(output, /\| Job \| Kind \| Status \| Phase \| Elapsed \| Liveness \|/);
  assert.match(output, /gem-live \|.*\| alive — log grew/);
  assert.match(output, /gem-quiet \|.*\| no log activity for/);
  assert.match(output, /gem-dead \|.*\| dead — process gone/);
  // All three claim the same status and elapsed, which is the whole point.
  assert.equal(running[0].elapsed, running[2].elapsed);
});
