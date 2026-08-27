import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { getMainWorktreeRoot } from "../plugins/gemini/scripts/lib/git.mjs";
import { getConfig, setConfig } from "../plugins/gemini/scripts/lib/state.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

function makeRepoWithWorktree() {
  const main = makeTempDir("wt-main-");
  initGitRepo(main);
  fs.writeFileSync(path.join(main, "a.txt"), "one\n");
  run("git", ["add", "-A"], { cwd: main });
  run("git", ["commit", "-m", "init"], { cwd: main });

  const linked = path.join(makeTempDir("wt-linked-"), "feature");
  run("git", ["worktree", "add", "-b", "feature", linked], { cwd: main });
  return { main, linked };
}

// resolveConfiguredReviewBase lives in the companion script, which is a CLI entry
// point; this mirrors its lookup so the inheritance rule itself is covered.
function lookupReviewBase(cwd, workspaceRoot) {
  const own = getConfig(workspaceRoot).reviewBase || null;
  if (own) return { base: own, inheritedFrom: null };
  const mainRoot = getMainWorktreeRoot(cwd);
  if (!mainRoot || mainRoot === workspaceRoot) return { base: null, inheritedFrom: null };
  const inherited = getConfig(mainRoot).reviewBase || null;
  return inherited ? { base: inherited, inheritedFrom: mainRoot } : { base: null, inheritedFrom: null };
}

function withPluginData(fn) {
  const dir = path.join(makeTempDir("wt-data-"), "gemini-data");
  fs.mkdirSync(dir, { recursive: true });
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dir;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
}

test("getMainWorktreeRoot returns the checkout itself for a main worktree", () => {
  const { main } = makeRepoWithWorktree();
  assert.equal(fs.realpathSync(getMainWorktreeRoot(main)), fs.realpathSync(main));
});

test("getMainWorktreeRoot resolves a linked worktree back to the main checkout", () => {
  const { main, linked } = makeRepoWithWorktree();
  assert.equal(fs.realpathSync(getMainWorktreeRoot(linked)), fs.realpathSync(main));
});

test("getMainWorktreeRoot returns null outside a repository", () => {
  assert.equal(getMainWorktreeRoot(makeTempDir("wt-plain-")), null);
});

test("a linked worktree inherits the main checkout's review base", () => {
  const { main, linked } = makeRepoWithWorktree();
  withPluginData(() => {
    setConfig(main, "reviewBase", "origin/internal-release");

    const result = lookupReviewBase(linked, linked);
    assert.equal(result.base, "origin/internal-release");
    assert.equal(fs.realpathSync(result.inheritedFrom), fs.realpathSync(main));
  });
});

test("a base set on the worktree wins over the inherited one", () => {
  const { main, linked } = makeRepoWithWorktree();
  withPluginData(() => {
    setConfig(main, "reviewBase", "origin/internal-release");
    setConfig(linked, "reviewBase", "origin/experiment");

    const result = lookupReviewBase(linked, linked);
    assert.equal(result.base, "origin/experiment");
    assert.equal(result.inheritedFrom, null);
  });
});

test("nothing is inherited when the main checkout has no base either", () => {
  const { linked } = makeRepoWithWorktree();
  withPluginData(() => {
    const result = lookupReviewBase(linked, linked);
    assert.equal(result.base, null);
    assert.equal(result.inheritedFrom, null);
  });
});

test("an unrelated repository inherits nothing", () => {
  const { main } = makeRepoWithWorktree();
  const other = makeTempDir("wt-other-");
  initGitRepo(other);
  fs.writeFileSync(path.join(other, "b.txt"), "two\n");
  run("git", ["add", "-A"], { cwd: other });
  run("git", ["commit", "-m", "init"], { cwd: other });

  withPluginData(() => {
    setConfig(main, "reviewBase", "origin/internal-release");
    const result = lookupReviewBase(other, other);
    assert.equal(result.base, null);
  });
});
