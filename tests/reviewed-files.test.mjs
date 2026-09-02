import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { collectReviewContext, resolveReviewTarget } from "../plugins/gemini/scripts/lib/git.mjs";
import { renderReviewResult } from "../plugins/gemini/scripts/lib/render.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

function cleanReview(meta) {
  return renderReviewResult(
    { parsed: { verdict: "approve", summary: "Fine." }, rawOutput: "{}", parseError: null },
    { reviewLabel: "Review", targetLabel: "working tree diff", ...meta }
  );
}

test("an inline diff reviews every changed file", () => {
  const cwd = makeTempDir("reviewed-inline-");
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "a.js"), "1;\n");
  fs.writeFileSync(path.join(cwd, "b.js"), "2;\n");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), "11;\n");
  fs.writeFileSync(path.join(cwd, "b.js"), "22;\n");

  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, {}));

  assert.equal(context.inputMode, "inline-diff");
  assert.deepEqual(context.reviewedFiles, ["a.js", "b.js"]);
  assert.deepEqual(context.omittedFiles, []);
});

// The point of the flag: on a truncated run the changed set and the reviewed set differ,
// and the report has to say which is which.
test("a truncated diff reports the dropped files as not reviewed", () => {
  const cwd = makeTempDir("reviewed-truncated-");
  initGitRepo(cwd);
  const names = ["a.js", "b.js", "c.js"];
  for (const name of names) {
    fs.writeFileSync(path.join(cwd, name), "x;\n");
  }
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  for (const name of names) {
    fs.writeFileSync(path.join(cwd, name), `${"y".repeat(400)};\n`);
  }

  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, {}), { maxInlineDiffBytes: 600 });

  assert.equal(context.inputMode, "truncated-diff");
  assert.ok(context.omittedFiles.length > 0, "some file did not fit");
  assert.equal(
    context.reviewedFiles.length + context.omittedFiles.length,
    context.fileCount,
    "the two lists together account for every changed file"
  );
  for (const file of context.reviewedFiles) {
    assert.ok(!context.omittedFiles.includes(file), `${file} cannot be in both lists`);
  }
});

// An untracked file reaches Gemini as whole content, so a per-file skip means it was
// named in the prompt but never actually read.
test("a skipped untracked file counts as not reviewed", () => {
  const cwd = makeTempDir("reviewed-untracked-");
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "seed.js"), "1;\n");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "small.js"), "ok;\n");
  fs.writeFileSync(path.join(cwd, "huge.js"), "z".repeat(40 * 1024));

  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, {}));

  assert.ok(context.reviewedFiles.includes("small.js"), "the small untracked file was read");
  assert.ok(context.omittedFiles.includes("huge.js"), "the oversized one was not");
});

test("the report lists reviewed files only when --show-files is set", () => {
  const meta = { reviewedFiles: ["a.js", "b.js"], omittedFiles: [] };

  assert.doesNotMatch(cleanReview(meta), /Files reviewed/);

  const output = cleanReview({ ...meta, showFiles: true });
  assert.match(output, /Files reviewed \(2\):/);
  assert.match(output, /- a\.js/);
  assert.match(output, /- b\.js/);
  assert.doesNotMatch(output, /Files NOT reviewed/);
});

test("the report names the files that were not reviewed", () => {
  const output = cleanReview({
    showFiles: true,
    reviewedFiles: ["a.js"],
    omittedFiles: ["big.js", "other.js"]
  });

  assert.match(output, /Files reviewed \(1\):/);
  assert.match(output, /Files NOT reviewed \(2\) — their content never reached Gemini:/);
  assert.match(output, /- big\.js/);
});

// After a failed run, "what did it even look at?" is the first question.
test("a run that returned no usable review still lists its files", () => {
  const output = renderReviewResult(
    { parsed: null, rawOutput: "", parseError: "no JSON" },
    {
      reviewLabel: "Review",
      targetLabel: "working tree diff",
      showFiles: true,
      reviewedFiles: ["a.js"],
      omittedFiles: []
    }
  );

  assert.match(output, /did not return valid structured JSON/);
  assert.match(output, /Files reviewed \(1\):/);
});

test("a review that covered nothing says so instead of printing an empty list", () => {
  const output = cleanReview({ showFiles: true, reviewedFiles: [], omittedFiles: ["a.js"] });

  assert.match(output, /Files reviewed \(0\):/);
  assert.match(output, /no file diff reached Gemini/);
});
