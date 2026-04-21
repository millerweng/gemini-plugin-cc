import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../plugins/gemini/scripts/lib/args.mjs";

const TASK_CONFIG = {
  valueOptions: ["model", "effort", "cwd", "prompt-file"],
  booleanOptions: ["json", "write", "plan", "resume-last", "resume", "fresh", "background"],
  aliasMap: { m: "model" }
};

test("write defaults to true when neither --write nor --plan is passed", () => {
  const { options } = parseArgs(["fix the bug"], TASK_CONFIG);
  const plan = Boolean(options.plan);
  const write = plan ? false : options.write !== false;
  assert.equal(write, true);
});

test("write is false when --plan is passed", () => {
  const { options } = parseArgs(["--plan", "analyze this"], TASK_CONFIG);
  const plan = Boolean(options.plan);
  const write = plan ? false : options.write !== false;
  assert.equal(write, false);
});

test("write is true when --write is explicitly passed", () => {
  const { options } = parseArgs(["--write", "fix it"], TASK_CONFIG);
  const plan = Boolean(options.plan);
  const write = plan ? false : options.write !== false;
  assert.equal(write, true);
});

test("write is false when --write=false is passed", () => {
  const { options } = parseArgs(["--write=false", "just read"], TASK_CONFIG);
  const plan = Boolean(options.plan);
  const write = plan ? false : options.write !== false;
  assert.equal(write, false);
});

test("--plan overrides --write to produce read-only mode", () => {
  const { options } = parseArgs(["--plan", "--write", "analyze"], TASK_CONFIG);
  const plan = Boolean(options.plan);
  const write = plan ? false : options.write !== false;
  assert.equal(write, false);
});
