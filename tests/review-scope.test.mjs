import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  collectReviewContext,
  measureReviewScope,
  resolveReviewTarget
} from "../plugins/gemini/scripts/lib/git.mjs";
import { renderReviewScopeReport } from "../plugins/gemini/scripts/lib/render.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

function repoWithChange(prefix, { lines = 1000, files = ["a.js", "b.js", "c.js"] } = {}) {
  const cwd = makeTempDir(prefix);
  initGitRepo(cwd);
  for (const name of files) {
    fs.writeFileSync(path.join(cwd, name), "x;\n");
  }
  run("git", ["add", "-A"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  const body = `${Array.from({ length: lines }, () => "y".repeat(140)).join("\n")}\n`;
  for (const name of files) {
    fs.writeFileSync(path.join(cwd, name), body);
  }
  return cwd;
}

// The whole point of the command: the prompt no longer decides this, so the pre-flight
// verdict and the real run must never disagree.
test("the scope verdict matches what the review actually does", () => {
  const cwd = repoWithChange("scope-agree-");
  const target = resolveReviewTarget(cwd, {});

  for (const budget of [64 * 1024, 256 * 1024, 8 * 1024 * 1024]) {
    const scope = measureReviewScope(cwd, target, { maxInlineDiffBytes: budget });
    const context = collectReviewContext(cwd, target, { maxInlineDiffBytes: budget });
    assert.equal(
      scope.willTruncate,
      context.inputMode === "truncated-diff",
      `budget ${budget}: scope said willTruncate=${scope.willTruncate}, run said ${context.inputMode}`
    );
  }
});

// This is the bug that started it: a configured budget the caller never saw.
test("a raised budget flips the verdict to fits", () => {
  const cwd = repoWithChange("scope-budget-");
  const target = resolveReviewTarget(cwd, {});

  assert.equal(measureReviewScope(cwd, target, { maxInlineDiffBytes: 256 * 1024 }).willTruncate, true);
  assert.equal(measureReviewScope(cwd, target, { maxInlineDiffBytes: 4 * 1024 * 1024 }).willTruncate, false);
});

// Measuring against the budget stops counting at it, which reported a 5 MB diff as
// "257 KB". The scope check probes past the budget so its number is real.
test("the scope check reports a real size, not the budget plus one", () => {
  const cwd = repoWithChange("scope-size-");
  const target = resolveReviewTarget(cwd, {});
  const budget = 64 * 1024;

  const scope = measureReviewScope(cwd, target, { maxInlineDiffBytes: budget });
  assert.equal(scope.diffBytesExact, true);
  assert.ok(scope.diffBytes > budget * 4, `expected a real size, got ${scope.diffBytes}`);

  // The review's own measurement stays capped, and says so rather than claiming exactness.
  const context = collectReviewContext(cwd, target, { maxInlineDiffBytes: budget });
  assert.equal(context.diffBytesExact, false);
  assert.equal(context.diffBytes, budget + 1);
});

test("the heaviest paths are ranked by churn", () => {
  const cwd = makeTempDir("scope-heavy-");
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "small.js"), "x;\n");
  fs.writeFileSync(path.join(cwd, "big.js"), "x;\n");
  run("git", ["add", "-A"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "small.js"), "y;\n");
  fs.writeFileSync(path.join(cwd, "big.js"), `${Array.from({ length: 300 }, () => "y").join("\n")}\n`);

  const scope = measureReviewScope(cwd, resolveReviewTarget(cwd, {}), {});
  assert.equal(scope.heaviestFiles[0].file, "big.js");
  assert.ok(scope.heaviestFiles[0].churn > scope.heaviestFiles[1].churn);
});

test("a diff that fits reports no truncation and no heaviest-path list", () => {
  const cwd = repoWithChange("scope-fits-", { lines: 2, files: ["a.js"] });
  const scope = measureReviewScope(cwd, resolveReviewTarget(cwd, {}), {});

  assert.equal(scope.willTruncate, false);
  const output = renderReviewScopeReport({
    ...scope,
    targetLabel: "working tree diff",
    diffBytesLabel: "1 KB",
    maxInlineDiffBytesLabel: "256 KB",
    maxInlineDiffBytesSource: "default"
  });
  assert.match(output, /Verdict: fits/);
  assert.doesNotMatch(output, /Heaviest paths/);
});

test("the truncating report names the budget and the heaviest paths", () => {
  const cwd = repoWithChange("scope-report-");
  const scope = measureReviewScope(cwd, resolveReviewTarget(cwd, {}), {
    maxInlineDiffBytes: 64 * 1024
  });

  const output = renderReviewScopeReport({
    ...scope,
    targetLabel: "working tree diff",
    diffBytesLabel: "416 KB",
    maxInlineDiffBytesLabel: "64 KB",
    maxInlineDiffBytesSource: "config"
  });
  assert.match(output, /Verdict: TRUNCATES/);
  assert.match(output, /Budget: 64 KB \(config\)/);
  assert.match(output, /Heaviest paths:/);
  assert.match(output, /- a\.js \(\d+ lines\)/);
});

// The command prompts forward `$ARGUMENTS` verbatim, so this command is handed the whole
// review invocation. Rejecting a review-only flag there fails the pre-flight check that
// exists to keep a review from silently covering less than it looks like.
test("review-scope accepts every flag the review command accepts", async () => {
  const { spawnSync } = await import("node:child_process");
  const cwd = repoWithChange("scope-flags-", { lines: 2, files: ["a.js"] });
  const script = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "plugins",
    "gemini",
    "scripts",
    "gemini-companion.mjs"
  );

  const run = (args) =>
    spawnSync(process.execPath, [script, "review-scope", "--cwd", cwd, ...args], {
      encoding: "utf8"
    });

  // The exact invocation that failed: review-only flags forwarded to the scope check.
  const forwarded = run(["--json", "--multi", "--background"]);
  assert.equal(forwarded.status, 0, forwarded.stderr);
  assert.equal(JSON.parse(forwarded.stdout).willTruncate, false);

  const everything = run([
    "--json",
    "--multi=security,resilience",
    "--wait",
    "--show-reasoning",
    "--show-files",
    "--progress",
    "--model",
    "pro",
    "focus text the user typed"
  ]);
  assert.equal(everything.status, 0, everything.stderr);

  // A real typo still fails, so the tolerance did not turn into swallowing mistakes.
  const typo = run(["--no-such-flag"]);
  assert.equal(typo.status, 1);
  assert.match(typo.stderr, /Unknown option --no-such-flag/);
});
