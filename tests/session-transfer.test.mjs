import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";

const {
  convertClaudeTranscript,
  projectHashFor,
  resolveClaudeSessionPath,
  writeGeminiSession
} = await import(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../plugins/gemini/scripts/lib/claude-session-transfer.mjs"
  )
);

function writeTranscript(rows) {
  const dir = makeTempDir("transfer-src-");
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  return file;
}

function userRow(text, extra = {}) {
  return {
    type: "user",
    uuid: `u-${Math.abs(text.length)}-${extra.tag ?? "0"}`,
    timestamp: "2026-08-25T01:00:00.000Z",
    message: { role: "user", content: text },
    ...extra
  };
}

function assistantRow(blocks, extra = {}) {
  return {
    type: "assistant",
    uuid: `a-${blocks.length}-${extra.tag ?? "0"}`,
    timestamp: "2026-08-25T01:00:01.000Z",
    message: { role: "assistant", content: blocks },
    ...extra
  };
}

test("converts user and assistant turns into gemini message types", () => {
  const file = writeTranscript([
    userRow("first question"),
    assistantRow([{ type: "text", text: "an answer" }])
  ]);

  const { messages, stats } = convertClaudeTranscript(file);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, "user");
  assert.equal(messages[0].content, "first question");
  assert.equal(messages[1].type, "gemini");
  assert.equal(messages[1].content, "an answer");
  assert.equal(stats.user, 1);
  assert.equal(stats.gemini, 1);
});

test("strips harness markup and drops turns that were only markup", () => {
  const file = writeTranscript([
    userRow("<command-name>/plugin</command-name><command-args>install x</command-args>"),
    userRow("real question <system-reminder>ignore me</system-reminder>")
  ]);

  const { messages } = convertClaudeTranscript(file);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, "real question");
});

test("skips sidechain and meta rows", () => {
  const file = writeTranscript([
    userRow("kept"),
    userRow("subagent chatter", { isSidechain: true, tag: "s" }),
    userRow("harness injection", { isMeta: true, tag: "m" })
  ]);

  const { messages } = convertClaudeTranscript(file);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, "kept");
});

test("collapses tool calls to one line and omits tool output by default", () => {
  const file = writeTranscript([
    userRow("go"),
    assistantRow([
      { type: "text", text: "running it" },
      { type: "tool_use", name: "Bash", input: { description: "list files" } }
    ]),
    userRow([{ type: "tool_result", content: "a very long tool payload" }], { tag: "tr" })
  ]);

  const { messages } = convertClaudeTranscript(file);
  const assistant = messages.find((message) => message.type === "gemini");
  assert.match(assistant.content, /\[tool: Bash\] list files/);
  assert.doesNotMatch(assistant.content, /very long tool payload/);
});

test("includes tool output when asked", () => {
  const file = writeTranscript([
    userRow("go"),
    userRow([{ type: "tool_result", content: "payload body" }], { tag: "tr" })
  ]);

  const { messages } = convertClaudeTranscript(file, { includeToolOutput: true });
  assert.ok(messages.some((message) => message.content.includes("payload body")));
});

test("drops leading assistant turns so the session starts on a user turn", () => {
  const file = writeTranscript([
    userRow("<command-name>/setup</command-name>"),
    assistantRow([{ type: "text", text: "answering the stripped command" }]),
    userRow("the actual question", { tag: "q" })
  ]);

  const { messages } = convertClaudeTranscript(file);
  assert.equal(messages[0].type, "user");
  assert.equal(messages[0].content, "the actual question");
});

test("writes a JSONL session with a header line Gemini can read back", () => {
  const cwd = makeTempDir("transfer-cwd-");
  const home = makeTempDir("transfer-home-");
  const previousHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const messages = [
      { id: "m1", timestamp: "2026-08-25T01:00:00.000Z", type: "user", content: "hello" },
      { id: "m2", timestamp: "2026-08-25T01:00:05.000Z", type: "gemini", content: "hi" }
    ];
    const written = writeGeminiSession(cwd, messages);

    const lines = fs.readFileSync(written.sessionFile, "utf8").trim().split("\n");
    assert.equal(lines.length, 3);

    const header = JSON.parse(lines[0]);
    assert.equal(header.sessionId, written.sessionId);
    assert.equal(header.kind, "main");
    assert.equal(header.projectHash, projectHashFor(cwd));

    // User turns carry a parts array; assistant turns carry a plain string.
    assert.deepEqual(JSON.parse(lines[1]).content, [{ text: "hello" }]);
    assert.equal(JSON.parse(lines[2]).content, "hi");
    assert.match(written.sessionFile, /\.jsonl$/);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

test("refuses a transcript outside ~/.claude/projects", () => {
  const stray = writeTranscript([userRow("nope")]);
  assert.throws(() => resolveClaudeSessionPath(process.cwd(), { source: stray }), /only be transferred from/);
});

test("refuses a source that is not JSONL", () => {
  assert.throws(
    () => resolveClaudeSessionPath(process.cwd(), { source: "/tmp/whatever.json" }),
    /must be a JSONL file/
  );
});

test("refuses to write an empty session", () => {
  assert.throws(() => writeGeminiSession(makeTempDir("transfer-empty-"), []), /no transferable/);
});
