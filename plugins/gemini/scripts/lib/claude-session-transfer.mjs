/**
 * Transfers a Claude Code session into a Gemini CLI session.
 *
 * Codex does this over an app-server RPC (externalAgentConfig/import). Gemini CLI
 * has no import RPC, so this module writes a native Gemini session file instead:
 * Gemini stores chats as JSON under ~/.gemini/tmp/<projectHash>/chats/, and both
 * `--session-file` and `--resume` read them back.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureAbsolutePath } from "./fs.mjs";

export const TRANSCRIPT_PATH_ENV = "GEMINI_COMPANION_TRANSCRIPT_PATH";
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const GEMINI_HOME = path.join(os.homedir(), ".gemini");

// Tool payloads dominate a Claude transcript and carry no conversational value
// once the tools are gone. They are collapsed to one line unless asked otherwise.
const MAX_TOOL_OUTPUT_CHARS = 2000;

function resolveUserPath(cwd, value) {
  if (value === "~") {
    return os.homedir();
  }
  if (String(value).startsWith("~/")) {
    return path.join(os.homedir(), String(value).slice(2));
  }
  return ensureAbsolutePath(cwd, value);
}

export function resolveClaudeSessionPath(cwd, options = {}) {
  const requestedPath = options.source || process.env[TRANSCRIPT_PATH_ENV];
  if (!requestedPath) {
    throw new Error(
      "Could not identify the current Claude transcript. Retry with --source <path-to-claude-jsonl>."
    );
  }

  const sourcePath = resolveUserPath(cwd, requestedPath);
  if (path.extname(sourcePath) !== ".jsonl") {
    throw new Error(`Claude session source must be a JSONL file: ${sourcePath}`);
  }

  let source;
  let projects;
  try {
    source = fs.realpathSync(sourcePath);
    projects = fs.realpathSync(CLAUDE_PROJECTS_DIR);
  } catch {
    throw new Error(`Claude session file not found: ${sourcePath}`);
  }
  const relative = path.relative(projects, source);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Claude sessions can only be transferred from ${CLAUDE_PROJECTS_DIR}: ${source}`);
  }
  return source;
}

export function projectHashFor(cwd) {
  return crypto.createHash("sha256").update(String(cwd)).digest("hex");
}

function readTranscriptRows(sourcePath) {
  const rows = [];
  const raw = fs.readFileSync(sourcePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // Claude appends the transcript line by line; a torn final line is normal.
    }
  }
  return rows;
}

// Claude wraps harness chatter in XML-ish tags: slash-command echoes, injected
// reminders, local command output. None of it is conversation, and leaving it in
// makes the first line of the transferred session unreadable.
const HARNESS_MARKUP = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<local-command-[a-z-]+>[\s\S]*?<\/local-command-[a-z-]+>/g,
  /<command-[a-z-]+>[\s\S]*?<\/command-[a-z-]+>/g,
  /<task-notification>[\s\S]*?<\/task-notification>/g
];

function stripHarnessMarkup(text) {
  let value = String(text ?? "");
  for (const pattern of HARNESS_MARKUP) {
    value = value.replace(pattern, "");
  }
  return value.trim();
}

function truncate(text, limit) {
  const value = String(text ?? "");
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}\n… (truncated, ${value.length - limit} more characters)`;
}

function describeToolUse(block) {
  const name = block.name ?? "tool";
  const input = block.input && typeof block.input === "object" ? block.input : {};
  const hint =
    input.description ??
    input.command ??
    input.file_path ??
    input.pattern ??
    input.prompt ??
    "";
  const summary = String(hint).replace(/\s+/g, " ").trim();
  return summary ? `[tool: ${name}] ${truncate(summary, 200)}` : `[tool: ${name}]`;
}

function flattenContent(content, options = {}) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    if (block.type === "text" && block.text) {
      parts.push(block.text);
      continue;
    }
    if (block.type === "tool_use") {
      parts.push(describeToolUse(block));
      continue;
    }
    if (block.type === "tool_result") {
      if (!options.includeToolOutput) {
        continue;
      }
      const body = typeof block.content === "string" ? block.content : flattenContent(block.content, options);
      if (body.trim()) {
        parts.push(`[tool result]\n${truncate(body, MAX_TOOL_OUTPUT_CHARS)}`);
      }
      continue;
    }
    // thinking / image / other blocks carry nothing Gemini can replay as text.
  }
  return parts.join("\n\n").trim();
}

/**
 * Converts Claude transcript rows into Gemini chat messages.
 * Sidechain rows are subagent conversations and meta rows are harness injections;
 * neither belongs in the transferred conversation.
 */
export function convertClaudeTranscript(sourcePath, options = {}) {
  const rows = readTranscriptRows(sourcePath);
  const messages = [];
  const stats = { user: 0, gemini: 0, skipped: 0 };

  for (const row of rows) {
    if (row.isSidechain === true || row.isMeta === true) {
      stats.skipped++;
      continue;
    }
    if (row.type !== "user" && row.type !== "assistant") {
      continue;
    }

    const message = row.message;
    if (!message || typeof message !== "object") {
      continue;
    }

    const content = stripHarnessMarkup(flattenContent(message.content, options));
    if (!content) {
      stats.skipped++;
      continue;
    }

    const type = row.type === "user" ? "user" : "gemini";
    stats[type]++;
    messages.push({
      id: typeof row.uuid === "string" ? row.uuid : crypto.randomUUID(),
      timestamp: typeof row.timestamp === "string" ? row.timestamp : new Date().toISOString(),
      type,
      content
    });
  }

  // Gemini titles a session from its first message, so it has to start on a user
  // turn. Assistant turns that answered stripped harness chatter are dropped.
  const firstUserIndex = messages.findIndex((message) => message.type === "user");
  if (firstUserIndex > 0) {
    stats.skipped += firstUserIndex;
    stats.gemini -= firstUserIndex;
    return { messages: messages.slice(firstUserIndex), stats };
  }

  return { messages, stats };
}

function sessionFileName(startTime, sessionId) {
  const stamp = startTime.replace(/:/g, "-").replace(/\..*$/, "").slice(0, 16);
  return `session-${stamp}-${sessionId.slice(0, 8)}.jsonl`;
}

/**
 * Gemini keys its chat directory by the short project name recorded in
 * ~/.gemini/projects.json, falling back to the project hash for a workspace it
 * has never opened.
 */
function resolveProjectDirName(cwd, projectHash) {
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(GEMINI_HOME, "projects.json"), "utf8"));
    const name = registry?.projects?.[cwd];
    if (typeof name === "string" && name.trim()) {
      return name.trim();
    }
  } catch {
    // No registry yet, or it is unreadable. The hash is always a valid directory name.
  }
  return projectHash;
}

/**
 * Writes the session as JSONL: a header line, then one line per message. That is
 * the layout `gemini --list-sessions` and `--session-file` expect.
 */
export function writeGeminiSession(cwd, messages, options = {}) {
  if (messages.length === 0) {
    throw new Error("The Claude transcript has no transferable conversation turns.");
  }

  const projectHash = projectHashFor(cwd);
  const projectDir = resolveProjectDirName(cwd, projectHash);
  const chatsDir = path.join(GEMINI_HOME, "tmp", projectDir, "chats");
  fs.mkdirSync(chatsDir, { recursive: true });

  const sessionId = crypto.randomUUID();
  const startTime = messages[0].timestamp;
  const lastUpdated = messages[messages.length - 1].timestamp;
  const sessionFile = path.join(chatsDir, sessionFileName(startTime, sessionId));

  const header = { sessionId, projectHash, startTime, lastUpdated, kind: "main" };
  const lines = [JSON.stringify(header)];
  for (const message of messages) {
    // User turns carry a parts array; assistant turns carry a plain string.
    const content = message.type === "user" ? [{ text: message.content }] : message.content;
    lines.push(JSON.stringify({ ...message, content }));
  }

  fs.writeFileSync(sessionFile, `${lines.join("\n")}\n`, "utf8");

  return { sessionId, sessionFile, projectHash, projectDir, ...(options.extra ?? {}) };
}
