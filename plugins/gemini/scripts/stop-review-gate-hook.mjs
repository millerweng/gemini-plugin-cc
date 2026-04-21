#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getGeminiAvailability, getGeminiAuthStatus, cleanGeminiStderr } from "./lib/gemini.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { getConfig, listJobs } from "./lib/state.mjs";
import { sortJobsNewestFirst } from "./lib/job-control.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const STOP_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

function filterJobsForCurrentSession(jobs, input = {}) {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function buildStopReviewPrompt(input = {}) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const claudeResponseBlock = lastAssistantMessage
    ? ["Previous Claude response:", lastAssistantMessage].join("\n")
    : "";
  return interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: claudeResponseBlock
  });
}

async function buildSetupNote(cwd) {
  const availability = getGeminiAvailability(cwd);
  if (!availability.available) {
    const detail = availability.detail ? ` ${availability.detail}.` : "";
    return `Gemini is not set up for the review gate.${detail} Run /gemini:setup.`;
  }

  const auth = await getGeminiAuthStatus(cwd);
  if (!auth.loggedIn) {
    const guidance = auth.authMethod
      ? `Auth type "${auth.authMethod}" is configured but credentials are missing or expired.`
      : "No auth type is configured.";
    return `Gemini review gate cannot run: ${guidance} ${auth.detail ?? ""} Run /gemini:setup or set GEMINI_API_KEY.`.trim();
  }

  return null;
}

function sanitizeErrorDetail(rawDetail) {
  let text = cleanGeminiStderr(rawDetail);

  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.message === "string") {
      text = parsed.message;
    } else if (typeof parsed?.error?.message === "string") {
      text = parsed.error.message;
    }
  } catch {
    // Not JSON, use as-is
  }

  text = text
    .split(/\r?\n/)
    .filter((line) => !line.match(/^\s+at /))
    .join("\n")
    .trim();

  if (text.length > 300) {
    text = text.slice(0, 297) + "...";
  }

  return text;
}

function classifyFailure(detail) {
  const lower = detail.toLowerCase();
  if (lower.includes("token") && (lower.includes("expired") || lower.includes("invalid"))) {
    return "oauth-expired";
  }
  if (lower.includes("oauth") && (lower.includes("refresh") || lower.includes("expired"))) {
    return "oauth-expired";
  }
  if (lower.includes("econnrefused") || lower.includes("connection refused")) {
    return "connection-refused";
  }
  if (lower.includes("enotfound") || lower.includes("getaddrinfo")) {
    return "dns-failure";
  }
  if (lower.includes("401") || lower.includes("unauthorized")) {
    return "auth-rejected";
  }
  return "generic";
}

function buildFailureGuidance(classification) {
  switch (classification) {
    case "oauth-expired":
    case "auth-rejected":
      return "Re-authenticate with `!gemini` or set GEMINI_API_KEY.";
    case "connection-refused":
    case "dns-failure":
      return "Check network connectivity or gateway configuration.";
    default:
      return "Run /gemini:review --wait manually or bypass the gate.";
  }
}

function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      reason:
        "The stop-time Gemini review task returned no final output. Run /gemini:review --wait manually or bypass the gate."
    };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      ok: false,
      reason: `Gemini stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }

  return {
    ok: false,
    reason:
      "The stop-time Gemini review task returned an unexpected answer. Run /gemini:review --wait manually or bypass the gate."
  };
}

function runStopReview(cwd, input = {}) {
  const scriptPath = path.join(SCRIPT_DIR, "gemini-companion.mjs");
  const prompt = buildStopReviewPrompt(input);
  const childEnv = {
    ...process.env,
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {})
  };
  const result = spawnSync(process.execPath, [scriptPath, "task", "--plan", "--json", prompt], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    timeout: STOP_REVIEW_TIMEOUT_MS
  });

  if (result.error?.code === "ETIMEDOUT") {
    return {
      ok: false,
      reason:
        "The stop-time Gemini review task timed out after 15 minutes. Run /gemini:review --wait manually or bypass the gate."
    };
  }

  if (result.status !== 0) {
    const rawDetail = String(result.stderr || result.stdout || "").trim();
    const sanitized = sanitizeErrorDetail(rawDetail);
    const classification = classifyFailure(sanitized);
    const guidance = buildFailureGuidance(classification);
    return {
      ok: false,
      reason: sanitized
        ? `The stop-time Gemini review task failed: ${sanitized}. ${guidance}`
        : `The stop-time Gemini review task failed. ${guidance}`
    };
  }

  try {
    const payload = JSON.parse(result.stdout);
    return parseStopReviewOutput(payload?.rawOutput);
  } catch {
    return {
      ok: false,
      reason:
        "The stop-time Gemini review task returned invalid JSON. Run /gemini:review --wait manually or bypass the gate."
    };
  }
}

async function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), input));
  const runningJob = jobs.find((job) => job.status === "queued" || job.status === "running");
  const runningTaskNote = runningJob
    ? `Gemini task ${runningJob.id} is still running. Check /gemini:status and use /gemini:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null;

  if (!config.stopReviewGate) {
    logNote(runningTaskNote);
    return;
  }

  const setupNote = await buildSetupNote(cwd);
  if (setupNote) {
    const parts = [setupNote];
    if (runningTaskNote) parts.push(runningTaskNote);
    emitDecision({
      decision: "block",
      reason: parts.join(" ")
    });
    return;
  }

  const review = runStopReview(cwd, input);
  if (!review.ok) {
    emitDecision({
      decision: "block",
      reason: runningTaskNote ? `${runningTaskNote} ${review.reason}` : review.reason
    });
    return;
  }

  logNote(runningTaskNote);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
