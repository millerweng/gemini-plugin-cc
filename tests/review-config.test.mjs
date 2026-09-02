import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { setConfig } from "../plugins/gemini/scripts/lib/state.mjs";
import {
  resolveConfiguredReviewBase,
  resolveShowReviewFiles
} from "../plugins/gemini/scripts/lib/review-config.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

function withPluginData(fn) {
  const dir = path.join(makeTempDir("cfg-data-"), "gemini-data");
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

function makeRepoWithWorktree() {
  const main = makeTempDir("cfg-main-");
  initGitRepo(main);
  fs.writeFileSync(path.join(main, "a.txt"), "one\n");
  run("git", ["add", "-A"], { cwd: main });
  run("git", ["commit", "-m", "init"], { cwd: main });
  const linked = path.join(makeTempDir("cfg-linked-"), "feature");
  run("git", ["worktree", "add", "-b", "feature", linked], { cwd: main });
  // git reports the main checkout by its real path, and on macOS the temp dir is reached
  // through a /var -> /private/var symlink.
  return { main: fs.realpathSync.native(main), linked };
}

test("covered-file reporting is off until it is configured", () => {
  withPluginData(() => {
    const repo = makeTempDir("cfg-default-");
    initGitRepo(repo);
    const resolved = resolveShowReviewFiles(repo, repo);
    assert.equal(resolved.enabled, false);
    assert.equal(resolved.source, "default");
  });
});

test("the workspace setting turns it on for every run", () => {
  withPluginData(() => {
    const repo = makeTempDir("cfg-on-");
    initGitRepo(repo);
    setConfig(repo, "showReviewFiles", true);
    const resolved = resolveShowReviewFiles(repo, repo);
    assert.equal(resolved.enabled, true);
    assert.equal(resolved.source, "config");
  });
});

// The point of --hide-files: a workspace with the setting on still needs a quiet run.
test("--hide-files silences one run in a workspace that has it on", () => {
  withPluginData(() => {
    const repo = makeTempDir("cfg-hide-");
    initGitRepo(repo);
    setConfig(repo, "showReviewFiles", true);
    const resolved = resolveShowReviewFiles(repo, repo, { hideFilesFlag: true });
    assert.equal(resolved.enabled, false);
    assert.equal(resolved.source, "flag");
  });
});

test("--show-files turns it on for one run without changing the setting", () => {
  withPluginData(() => {
    const repo = makeTempDir("cfg-show-");
    initGitRepo(repo);
    const resolved = resolveShowReviewFiles(repo, repo, { showFilesFlag: true });
    assert.equal(resolved.enabled, true);
    assert.equal(resolved.source, "flag");
    assert.equal(resolveShowReviewFiles(repo, repo).enabled, false, "the setting is untouched");
  });
});

test("a linked worktree inherits the setting from the main checkout", () => {
  withPluginData(() => {
    const { main, linked } = makeRepoWithWorktree();
    setConfig(main, "showReviewFiles", true);
    const resolved = resolveShowReviewFiles(linked, linked);
    assert.equal(resolved.enabled, true);
    assert.equal(resolved.inheritedFrom, main);
  });
});

// `false` has to be distinguishable from unset, or a worktree could never turn it off.
test("a worktree that turns it off does not inherit true back", () => {
  withPluginData(() => {
    const { main, linked } = makeRepoWithWorktree();
    setConfig(main, "showReviewFiles", true);
    setConfig(linked, "showReviewFiles", false);
    const resolved = resolveShowReviewFiles(linked, linked);
    assert.equal(resolved.enabled, false);
    assert.equal(resolved.source, "config");
    assert.equal(resolved.inheritedFrom, null);
  });
});

// This helper used to be mirrored inside the test file, so the real code was unguarded.
test("the review base uses the same inheritance rule", () => {
  withPluginData(() => {
    const { main, linked } = makeRepoWithWorktree();
    setConfig(main, "reviewBase", "origin/internal-release");
    assert.deepEqual(resolveConfiguredReviewBase(linked, linked), {
      base: "origin/internal-release",
      inheritedFrom: main
    });

    setConfig(linked, "reviewBase", "origin/experiment");
    assert.deepEqual(resolveConfiguredReviewBase(linked, linked), {
      base: "origin/experiment",
      inheritedFrom: null
    });
  });
});
