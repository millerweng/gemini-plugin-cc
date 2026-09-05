import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  collectReviewContext,
  measureReviewScope,
  resolveReviewTarget
} from "../plugins/gemini/scripts/lib/git.mjs";
import { parseExcludePatterns, resolveExcludePatterns } from "../plugins/gemini/scripts/lib/review-config.mjs";
import { setConfig } from "../plugins/gemini/scripts/lib/state.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

function withPluginData(fn) {
  const dir = path.join(makeTempDir("ex-data-"), "gemini-data");
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

// The shape that started this: one source tree plus two installed copies of itself.
function repoWithRunningCopies(prefix) {
  const cwd = makeTempDir(prefix);
  initGitRepo(cwd);
  const write = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), body);
  };
  for (const root of [".claude", ".gemini", "developer"]) {
    write(`${root}/agents/writer.md`, "v1\n");
    write(`${root}/skills/emp/references/protocol.md`, "v1\n");
  }
  run("git", ["add", "-A"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  for (const root of [".claude", ".gemini", "developer"]) {
    write(`${root}/agents/writer.md`, "v1\nv2\n");
    write(`${root}/skills/emp/references/protocol.md`, "v1\nv2\n");
  }
  return cwd;
}

test("an exclude drops the whole subtree, nested files included", () => {
  const cwd = repoWithRunningCopies("ex-subtree-");
  const target = resolveReviewTarget(cwd, {});

  assert.equal(measureReviewScope(cwd, target, {}).fileCount, 6);

  const scoped = measureReviewScope(cwd, target, { excludePatterns: [".claude", ".gemini"] });
  assert.equal(scoped.fileCount, 2);
  assert.deepEqual(scoped.changedFiles, [
    "developer/agents/writer.md",
    "developer/skills/emp/references/protocol.md"
  ]);
});

// The review itself has to agree with the scope check, or the exclusion is cosmetic.
test("the review context reviews only the files that survived the exclude", () => {
  const cwd = repoWithRunningCopies("ex-context-");
  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target, { excludePatterns: [".claude", ".gemini"] });

  assert.equal(context.fileCount, 2);
  assert.deepEqual(context.reviewedFiles, [
    "developer/agents/writer.md",
    "developer/skills/emp/references/protocol.md"
  ]);
  assert.doesNotMatch(context.content, /\.claude|\.gemini/);
  assert.deepEqual(context.excludePatterns, [".claude", ".gemini"]);
});

test("an excluded untracked file is not sent as content", () => {
  const cwd = repoWithRunningCopies("ex-untracked-");
  fs.writeFileSync(path.join(cwd, ".claude", "brand-new.md"), "secret-marker\n");
  fs.writeFileSync(path.join(cwd, "developer", "kept.md"), "kept-marker\n");

  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, {}), {
    excludePatterns: [".claude"]
  });

  assert.match(context.content, /kept-marker/);
  assert.doesNotMatch(context.content, /secret-marker/);
});

// A tree whose only change is excluded has nothing to review, and must not be treated as
// dirty — otherwise the review runs against an empty working-tree diff.
test("excluded changes do not make the working tree look dirty", () => {
  const cwd = makeTempDir("ex-clean-");
  initGitRepo(cwd);
  fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src.js"), "v1;\n");
  fs.writeFileSync(path.join(cwd, ".claude", "copy.md"), "v1\n");
  run("git", ["add", "-A"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, ".claude", "copy.md"), "v2\n");

  assert.equal(resolveReviewTarget(cwd, {}).mode, "working-tree");
  assert.equal(resolveReviewTarget(cwd, { excludePatterns: [".claude"] }).mode, "branch");
});

test("excluding frees the diff budget for the real source", () => {
  const cwd = makeTempDir("ex-budget-");
  initGitRepo(cwd);
  const bulk = `${Array.from({ length: 900 }, () => "y".repeat(140)).join("\n")}\n`;
  fs.mkdirSync(path.join(cwd, "vendor"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "vendor", "bundle.js"), "v1;\n");
  fs.writeFileSync(path.join(cwd, "src.js"), "v1;\n");
  run("git", ["add", "-A"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "vendor", "bundle.js"), bulk);
  fs.writeFileSync(path.join(cwd, "src.js"), "v2;\n");

  const target = resolveReviewTarget(cwd, {});
  assert.equal(measureReviewScope(cwd, target, { maxInlineDiffBytes: 64 * 1024 }).willTruncate, true);
  assert.equal(
    measureReviewScope(cwd, target, { maxInlineDiffBytes: 64 * 1024, excludePatterns: ["vendor"] })
      .willTruncate,
    false
  );
});

// Pathspec magic in a stored pattern could turn an exclusion into an inclusion, which
// would widen the review while looking like it narrowed it.
test("pathspec magic and paths outside the repo are rejected", () => {
  for (const bad of [":(exclude)src", ":!src", "/etc/passwd", "../outside", "~/home"]) {
    assert.throws(() => parseExcludePatterns(bad), /not allowed|relative to|stay inside/, bad);
  }
});

test("patterns are trimmed, de-duplicated, and stripped of trailing slashes", () => {
  assert.deepEqual(parseExcludePatterns(".claude/, .gemini , .claude"), [".claude", ".gemini"]);
});

test("the workspace setting applies to every run and --no-exclude silences it", () => {
  withPluginData(() => {
    const repo = makeTempDir("ex-cfg-");
    initGitRepo(repo);
    setConfig(repo, "excludePaths", [".claude", ".gemini"]);

    assert.deepEqual(resolveExcludePatterns(repo, repo).patterns, [".claude", ".gemini"]);
    assert.deepEqual(resolveExcludePatterns(repo, repo, { noExcludeFlag: true }).patterns, []);
    assert.deepEqual(resolveExcludePatterns(repo, repo, { flagValue: "dist" }).patterns, ["dist"]);
  });
});

// Runs on every review, so a broken settings file must not break the command. Excluding
// nothing reviews too much, never too little — the safe direction to fail in.
test("a corrupt stored exclude list falls back to excluding nothing", () => {
  withPluginData(() => {
    const repo = makeTempDir("ex-bad-");
    initGitRepo(repo);
    setConfig(repo, "excludePaths", [":(exclude)src", "/abs"]);
    const resolved = resolveExcludePatterns(repo, repo);
    assert.deepEqual(resolved.patterns, []);
    assert.equal(resolved.source, "default");
  });
});

// A reader who sees only "4 files reviewed" cannot tell a deliberately narrowed review
// from one that lost 18 files to truncation, and those call for opposite reactions.
test("the report separates a chosen scope from a coverage gap", async () => {
  const { renderReviewResult } = await import("../plugins/gemini/scripts/lib/render.mjs");
  const output = renderReviewResult(
    { parsed: { verdict: "approve", summary: "Fine.", findings: [] }, rawOutput: "{}", parseError: null },
    {
      reviewLabel: "Review",
      targetLabel: "working tree diff",
      showFiles: true,
      reviewedFiles: ["developer/a.md"],
      omittedFiles: ["big.js"],
      excludePatterns: [".claude", ".gemini"],
      excludedFiles: ["...".repeat(0)].slice(0, 0).concat(Array.from({ length: 8 }, (_, i) => `.claude/x${i}.md`))
    }
  );

  assert.match(output, /Deliberately excluded: \.claude, \.gemini — 8 changed file\(s\) held back/);
  assert.match(output, /not a coverage gap/);
  // The gap list stays separate and keeps its own wording.
  assert.match(output, /Files NOT reviewed \(1\) — their content never reached Gemini:/);
});

test("no exclusion means no excluded-scope line at all", async () => {
  const { renderReviewResult } = await import("../plugins/gemini/scripts/lib/render.mjs");
  const output = renderReviewResult(
    { parsed: { verdict: "approve", summary: "Fine.", findings: [] }, rawOutput: "{}", parseError: null },
    {
      reviewLabel: "Review",
      targetLabel: "working tree diff",
      showFiles: true,
      reviewedFiles: ["a.js"],
      omittedFiles: [],
      excludePatterns: []
    }
  );
  assert.doesNotMatch(output, /Deliberately excluded/);
});

test("the excluded file list is derived, so a wide glob is visible rather than silent", () => {
  const cwd = repoWithRunningCopies("ex-derived-");
  const target = resolveReviewTarget(cwd, { excludePatterns: [".claude", ".gemini"] });
  const context = collectReviewContext(cwd, target, { excludePatterns: [".claude", ".gemini"] });

  assert.equal(context.excludedFiles.length, 4);
  assert.equal(context.reviewedFiles.length + context.excludedFiles.length, 6);
  for (const file of context.excludedFiles) {
    assert.match(file, /^\.(claude|gemini)\//);
  }
});

// `*.md` matches at any depth in a git pathspec, which surprises people. An exclusion that
// wide empties the working tree, and the review then silently falls back to a branch diff —
// a different review from the one asked for. The flip has to be reported, not absorbed.
test("exclusions wide enough to empty the working tree are reported", async () => {
  const cwd = repoWithRunningCopies("ex-glob-");
  const target = resolveReviewTarget(cwd, { excludePatterns: ["*.md"] });

  assert.equal(target.mode, "branch", "nothing left uncommitted to review");
  assert.equal(target.excludedAwayWorkingTree, true);

  const { renderReviewResult } = await import("../plugins/gemini/scripts/lib/render.mjs");
  const output = renderReviewResult(
    { parsed: { verdict: "approve", summary: "Fine.", findings: [] }, rawOutput: "{}", parseError: null },
    {
      reviewLabel: "Review",
      targetLabel: target.label,
      excludePatterns: ["*.md"],
      excludedAwayWorkingTree: true
    }
  );
  assert.match(output, /Warning: every uncommitted change was excluded by \*\.md/);
  assert.match(output, /reviewed the branch diff instead of your working tree/);
});

// A normal exclusion leaves work behind, so no flip and no warning.
test("a partial exclusion keeps the working-tree review", () => {
  const cwd = repoWithRunningCopies("ex-partial-");
  const target = resolveReviewTarget(cwd, { excludePatterns: [".claude", ".gemini"] });

  assert.equal(target.mode, "working-tree");
  assert.ok(!target.excludedAwayWorkingTree);
});
