import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "gemini");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /gemini-companion\.mjs" review/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\]/);
});

test("adversarial review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/adversarial-review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /gemini-companion\.mjs" adversarial-review/);
});

test("all expected commands are present", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "adversarial-review.md",
    "cancel.md",
    "delegate.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md"
  ]);
});

test("rescue command routes through the gemini-rescue subagent", () => {
  const rescue = read("commands/rescue.md");
  const agent = read("agents/gemini-rescue.md");
  const runtimeSkill = read("skills/gemini-cli-runtime/SKILL.md");

  assert.match(rescue, /--background\|--wait/);
  assert.match(rescue, /--resume\|--fresh/);
  assert.match(rescue, /--model/);
  assert.match(rescue, /--effort/);
  assert.match(rescue, /task-resume-candidate/);
  assert.match(rescue, /AskUserQuestion/);
  assert.match(agent, /--resume/);
  assert.match(agent, /--fresh/);
  assert.match(agent, /thin forwarding wrapper/i);
  assert.match(agent, /Use exactly one `Bash` call/i);
  assert.match(agent, /Do not inspect the repository/i);
  assert.match(runtimeSkill, /only job is to invoke `task` once and return that stdout unchanged/i);
  assert.match(runtimeSkill, /Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
});

test("delegate command exists alongside rescue for general-purpose delegation", () => {
  const delegate = read("commands/delegate.md");
  assert.match(delegate, /--background\|--wait/);
  assert.match(delegate, /--resume\|--fresh/);
  assert.match(delegate, /--model/);
  assert.match(delegate, /--effort/);
  assert.match(delegate, /gemini:gemini-rescue/);
});

test("result and cancel commands are deterministic runtime entrypoints", () => {
  const result = read("commands/result.md");
  const cancel = read("commands/cancel.md");
  const resultHandling = read("skills/gemini-result-handling/SKILL.md");

  assert.match(result, /disable-model-invocation:\s*true/);
  assert.match(result, /gemini-companion\.mjs" result/);
  assert.match(cancel, /disable-model-invocation:\s*true/);
  assert.match(cancel, /gemini-companion\.mjs" cancel/);
  assert.match(resultHandling, /do not turn a failed or incomplete Gemini run into a Claude-side implementation attempt/i);
});

test("internal docs use task terminology for rescue runs", () => {
  const runtimeSkill = read("skills/gemini-cli-runtime/SKILL.md");
  const promptingSkill = read("skills/gemini-3-prompting/SKILL.md");

  assert.match(runtimeSkill, /gemini-companion\.mjs" task "<raw arguments>"/);
  assert.match(runtimeSkill, /Use `task` for every rescue request/i);
  assert.match(runtimeSkill, /task --resume-last/i);
});

test("hooks keep session-end cleanup and stop gating enabled", () => {
  const source = read("hooks/hooks.json");
  assert.match(source, /SessionStart/);
  assert.match(source, /SessionEnd/);
  assert.match(source, /stop-review-gate-hook\.mjs/);
  assert.match(source, /session-lifecycle-hook\.mjs/);
});

test("setup command can offer Gemini install and toggle review gate", () => {
  const setup = read("commands/setup.md");
  assert.match(setup, /argument-hint:\s*'\[--enable-review-gate\|--disable-review-gate\]'/);
  assert.match(setup, /AskUserQuestion/);
  assert.match(setup, /gemini-companion\.mjs" setup/);
});
