import test from "node:test";
import assert from "node:assert/strict";

import { renderReviewResult, renderStoredJobResult } from "../plugins/gemini/scripts/lib/render.mjs";

// A clean verdict with no findings array is a complete review, not a broken payload.
// It used to be thrown away and printed as raw JSON.
test("renderReviewResult renders a clean verdict that omits the findings array", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.doesNotMatch(output, /unexpected review shape/);
  assert.match(output, /Verdict: approve/);
  assert.match(output, /Looks fine\./);
  assert.match(output, /No material findings\./);
  assert.match(output, /Gemini omitted `findings`/);
});

test("renderReviewResult renders a structured result when next_steps is absent", () => {
  const parsed = {
    verdict: "needs-attention",
    summary: "Denylist is incomplete.",
    findings: [
      {
        file: "src/context.py",
        line_start: 9,
        line_end: 18,
        confidence: 1.0,
        recommendation: "Add /proc, /sys, /dev to DANGEROUS_SYSTEM_ROOTS."
      }
    ]
  };
  const output = renderReviewResult(
    { parsed, rawOutput: JSON.stringify(parsed), parseError: null },
    { reviewLabel: "Review", targetLabel: "branch diff against master" }
  );

  assert.doesNotMatch(output, /unexpected review shape/);
  assert.doesNotMatch(output, /Missing array/);
  assert.match(output, /Verdict: needs-attention/);
  assert.match(output, /Findings:/);
  assert.match(output, /src\/context\.py:9-18/);
  assert.match(output, /Add \/proc/);
});

test("renderReviewResult flags next_steps when present but not an array", () => {
  const parsed = {
    verdict: "approve",
    summary: "Fine.",
    findings: [],
    next_steps: "do the thing"
  };
  const output = renderReviewResult(
    { parsed, rawOutput: JSON.stringify(parsed), parseError: null },
    { reviewLabel: "Review", targetLabel: "working tree diff" }
  );

  assert.match(output, /`next_steps` must be an array when present/);
});

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Gemini Adversarial Review",
      jobClass: "review",
      threadId: "ses_123"
    },
    {
      threadId: "ses_123",
      rendered: "# Gemini Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput:
          '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# Gemini Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Gemini session ID: ses_123/);
  assert.match(output, /Resume in Gemini: gemini --resume ses_123/);
});

// Regression: a real /gemini:review run returned findings and a summary but no
// `verdict`, and the renderer threw the whole analysis away to print raw JSON.
// Showing the model the schema does not guarantee it follows one.
test("renderReviewResult renders a structured result when verdict is absent", () => {
  const parsed = {
    summary: "File Write (Zip Slip) vulnerability when extracting the .md file.",
    findings: [
      {
        file: "services/report_service.py",
        line_start: 305,
        line_end: 305,
        confidence: 1.0,
        recommendation: "Sanitize md_filename before building the destination path."
      }
    ]
  };
  const output = renderReviewResult(
    { parsed, rawOutput: JSON.stringify(parsed), parseError: null },
    { reviewLabel: "Review", targetLabel: "branch diff against main" }
  );

  assert.doesNotMatch(output, /unexpected review shape/);
  assert.doesNotMatch(output, /Missing string/);
  // Findings were raised, so the inferred verdict must not be an approval.
  assert.match(output, /Verdict: needs-attention/);
  assert.match(output, /services\/report_service\.py:305/);
  assert.match(output, /Sanitize md_filename/);
  assert.match(output, /Gemini omitted `verdict`/);
});

test("an empty findings array with no verdict infers approval", () => {
  const parsed = { summary: "Nothing material.", findings: [] };
  const output = renderReviewResult(
    { parsed, rawOutput: "{}", parseError: null },
    { reviewLabel: "Review", targetLabel: "working tree" }
  );

  assert.match(output, /Verdict: approve/);
  assert.match(output, /No material findings\./);
});

test("renderReviewResult still degrades when the payload has no review content", () => {
  const parsed = { note: "I could not review this." };
  const output = renderReviewResult(
    { parsed, rawOutput: JSON.stringify(parsed), parseError: null },
    { reviewLabel: "Review", targetLabel: "working tree" }
  );

  assert.match(output, /unexpected review shape/);
  assert.match(output, /nothing reviewable/);
  assert.match(output, /Raw final message:/);
});

test("renderReviewResult warns when the diff had to be truncated", () => {
  const parsed = { verdict: "approve", summary: "Routine bump.", findings: [] };
  const output = renderReviewResult(
    { parsed, rawOutput: "{}", parseError: null },
    {
      reviewLabel: "Review",
      targetLabel: "working tree diff",
      inputMode: "truncated-diff",
      fileCount: 3,
      diffBytes: 300 * 1024
    }
  );

  assert.match(output, /too large to send in full/);
  assert.match(output, /3 files/);
  assert.match(output, /300 KB of diff/);
  assert.match(output, /were not reviewed at all/);
});

test("renderReviewResult stays quiet about input mode when the diff was inlined", () => {
  const parsed = { verdict: "approve", summary: "Routine bump.", findings: [] };
  const output = renderReviewResult(
    { parsed, rawOutput: "{}", parseError: null },
    { reviewLabel: "Review", targetLabel: "working tree diff", inputMode: "inline-diff" }
  );

  assert.doesNotMatch(output, /too large to send in full/);
});

// Regression: parseError was built from `error?.message ?? stderr`, and `??` lets an
// empty string through, so a Gemini exit with no stderr rendered a bare
// "- Parse error:" with nothing after it.
test("renderReviewResult explains itself when there is no parse error text", () => {
  const output = renderReviewResult(
    { parsed: null, rawOutput: "", parseError: "" },
    { reviewLabel: "Review", targetLabel: "working tree diff" }
  );

  assert.match(output, /did not return valid structured JSON/);
  assert.match(output, /no reason reported/);
  assert.doesNotMatch(output, /Parse error:\s*$/m);
});

test("renderReviewResult warns when an auto-detected base covers a huge range", () => {
  const parsed = { verdict: "approve", summary: "Fine.", findings: [] };
  const output = renderReviewResult(
    { parsed, rawOutput: "{}", parseError: null },
    {
      reviewLabel: "Review",
      targetLabel: "branch diff against main",
      baseRef: "main",
      baseWasDetected: true,
      fileCount: 279,
      mergeBase: "3d3a1b40aaaaaaaa"
    }
  );

  assert.match(output, /base `main` was auto-detected/);
  assert.match(output, /279 files/);
  assert.match(output, /merge-base 3d3a1b40/);
  assert.match(output, /rerun with `--base <ref>`/);
});

test("an explicitly chosen base is never second-guessed", () => {
  const parsed = { verdict: "approve", summary: "Fine.", findings: [] };
  const output = renderReviewResult(
    { parsed, rawOutput: "{}", parseError: null },
    {
      reviewLabel: "Review",
      targetLabel: "branch diff against origin/internal-release",
      baseRef: "origin/internal-release",
      baseWasDetected: false,
      fileCount: 279
    }
  );

  assert.doesNotMatch(output, /auto-detected/);
});

test("a small auto-detected range does not warn", () => {
  const parsed = { verdict: "approve", summary: "Fine.", findings: [] };
  const output = renderReviewResult(
    { parsed, rawOutput: "{}", parseError: null },
    {
      reviewLabel: "Review",
      targetLabel: "branch diff against main",
      baseRef: "main",
      baseWasDetected: true,
      fileCount: 3
    }
  );

  assert.doesNotMatch(output, /auto-detected/);
});

// The reasoning trace restates the findings at length. On a review that parsed it is
// dead weight in whatever reads the output, so it is opt-in.
test("a successful review hides the reasoning trace by default", () => {
  const parsed = { verdict: "approve", summary: "Fine.", findings: [] };
  const output = renderReviewResult(
    { parsed, rawOutput: "{}", parseError: null },
    {
      reviewLabel: "Review",
      targetLabel: "working tree diff",
      reasoningSummary: ["Reviewing unstaged changes", "Checking the skill docs"]
    }
  );

  assert.doesNotMatch(output, /Reasoning:/);
  assert.doesNotMatch(output, /Reviewing unstaged changes/);
  assert.match(output, /Verdict: approve/);
});

test("--show-reasoning brings the trace back", () => {
  const parsed = { verdict: "approve", summary: "Fine.", findings: [] };
  const output = renderReviewResult(
    { parsed, rawOutput: "{}", parseError: null },
    {
      reviewLabel: "Review",
      targetLabel: "working tree diff",
      reasoningSummary: ["Reviewing unstaged changes"],
      showReasoning: true
    }
  );

  assert.match(output, /Reasoning:/);
  assert.match(output, /Reviewing unstaged changes/);
});

// When nothing parsed, the trace is the only evidence of what Gemini did, so it is
// printed whether or not it was asked for.
test("a failed review keeps the reasoning trace without being asked", () => {
  const output = renderReviewResult(
    { parsed: null, rawOutput: "", parseError: "" },
    {
      reviewLabel: "Review",
      targetLabel: "working tree diff",
      reasoningSummary: ["Analyzing token limits"]
    }
  );

  assert.match(output, /Reasoning:/);
  assert.match(output, /Analyzing token limits/);
});

test("a shape-rejected payload also keeps the trace", () => {
  const output = renderReviewResult(
    { parsed: { note: "nope" }, rawOutput: '{"note":"nope"}', parseError: null },
    {
      reviewLabel: "Review",
      targetLabel: "working tree diff",
      reasoningSummary: ["Analyzing token limits"]
    }
  );

  assert.match(output, /nothing reviewable/);
  assert.match(output, /Analyzing token limits/);
});

// Settings land wherever CLAUDE_PLUGIN_DATA points, which Claude Code sets and a plain
// shell does not. Naming the file is what makes a setting written to the wrong place
// visible instead of looking like it worked.
test("renderSetupReport names the settings file and the review base", async () => {
  const { renderSetupReport } = await import("../plugins/gemini/scripts/lib/render.mjs");
  const output = renderSetupReport({
    ready: true,
    node: { detail: "v24" },
    npm: { detail: "11" },
    gemini: { detail: "0.57.0" },
    auth: { detail: "Google OAuth (personal)", verified: true },
    sessionRuntime: { label: "direct startup" },
    reviewGateEnabled: false,
    reviewBase: "origin/internal-release",
    configFile: "/home/u/.claude/plugins/data/gemini-x/state/repo-abc/state.json",
    actionsTaken: [],
    nextSteps: []
  });

  assert.match(output, /review base: origin\/internal-release/);
  assert.match(output, /settings file: .*state\.json/);
});

test("renderSetupReport says auto-detected when no base is pinned", async () => {
  const { renderSetupReport } = await import("../plugins/gemini/scripts/lib/render.mjs");
  const output = renderSetupReport({
    ready: true,
    node: { detail: "v24" },
    npm: { detail: "11" },
    gemini: { detail: "0.57.0" },
    auth: { detail: "ok", verified: true },
    sessionRuntime: { label: "direct startup" },
    reviewGateEnabled: false,
    reviewBase: null,
    configFile: "/tmp/x/state.json",
    actionsTaken: [],
    nextSteps: []
  });

  assert.match(output, /review base: auto-detected/);
});

test("a repaired payload says so in the output", () => {
  const parsed = { verdict: "approve", summary: "ok", findings: [] };
  const output = renderReviewResult(
    { parsed, rawOutput: "{}", parseError: null, parseRepaired: "escaped raw control characters inside string values" },
    { reviewLabel: "Review", targetLabel: "working tree diff" }
  );

  assert.match(output, /the JSON needed repair/);
  assert.match(output, /control characters/);
});

// A failing run can carry hundreds of reasoning entries; the tail says how it ended.
test("a long reasoning trace is trimmed to its tail", () => {
  const reasoningSummary = Array.from({ length: 40 }, (_, index) => `step ${index + 1}`);
  const output = renderReviewResult(
    { parsed: null, rawOutput: "", parseError: "boom" },
    { reviewLabel: "Review", targetLabel: "working tree diff", reasoningSummary }
  );

  assert.match(output, /28 earlier entries omitted/);
  assert.match(output, /step 40/);
  assert.doesNotMatch(output, /step 1\b/);
});

test("a short reasoning trace is shown whole with no omission notice", () => {
  const output = renderReviewResult(
    { parsed: null, rawOutput: "", parseError: "boom" },
    { reviewLabel: "Review", targetLabel: "working tree diff", reasoningSummary: ["only step"] }
  );

  assert.match(output, /only step/);
  assert.doesNotMatch(output, /earlier entries omitted/);
});

test("a multi-lens finding renders every wording the merge kept", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "needs-attention",
        summary: "Correctness: bad.\nSecurity: also bad.",
        findings: [
          {
            severity: "critical",
            title: "Merge drops findings",
            body: "The primary explanation.",
            file: "src/merge.mjs",
            line_start: 10,
            line_end: 12,
            recommendation: "Guard the group.",
            lenses: ["correctness", "security"],
            lens_hits: 2,
            alternate_titles: ["Merge silently discards findings"],
            alternate_recommendations: ["Compare titles first."],
            alternate_bodies: ["A different account of the impact."]
          }
        ],
        next_steps: []
      }
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff",
      lensRuns: [
        { lens: "correctness", ok: true, findingCount: 1, parseError: null },
        { lens: "security", ok: true, findingCount: 1, parseError: null }
      ]
    }
  );

  assert.match(output, /Lenses: correctness \(1\), security \(1\)/);
  assert.match(output, /confirmed by 2 lenses: correctness, security/);
  assert.match(output, /Also reported as: Merge silently discards findings/);
  assert.match(output, /Alternative explanation: A different account of the impact\./);
  assert.match(output, /Alternative recommendation: Compare titles first\./);
});

test("a partial multi-lens review warns and says the exit is non-zero", () => {
  const output = renderReviewResult(
    { parsed: { verdict: "needs-attention", summary: "", findings: [], next_steps: [] } },
    {
      reviewLabel: "Review",
      targetLabel: "working tree diff",
      lensRuns: [
        { lens: "correctness", ok: true, findingCount: 0, parseError: null },
        { lens: "security", ok: false, findingCount: 0, parseError: "not JSON" }
      ]
    }
  );

  assert.match(output, /security — failed/);
  assert.match(output, /exits non-zero/);
  assert.match(output, /not JSON/);
});

test("a failed pass prints the text the model actually returned", () => {
  const output = renderReviewResult(
    { parsed: { verdict: "approve", summary: "", findings: [], next_steps: [] } },
    {
      reviewLabel: "Review",
      targetLabel: "working tree diff",
      lensRuns: [
        { lens: "correctness", ok: true, findingCount: 0, parseError: null, rawOutput: null },
        {
          lens: "security",
          ok: false,
          findingCount: 0,
          parseError: "Bad control character in string literal",
          rawOutput: "I cannot review this diff because it exceeds my context window."
        }
      ]
    }
  );

  assert.match(output, /Raw output from the security pass:/);
  assert.match(output, /exceeds my context window/);
});

test("a very long raw output is truncated with a pointer to the json payload", () => {
  const output = renderReviewResult(
    { parsed: { verdict: "approve", summary: "", findings: [], next_steps: [] } },
    {
      reviewLabel: "Review",
      targetLabel: "working tree diff",
      lensRuns: [
        {
          lens: "security",
          ok: false,
          findingCount: 0,
          parseError: "not JSON",
          rawOutput: "x".repeat(5000)
        }
      ]
    }
  );

  assert.match(output, /more characters; full text is in the --json payload/);
  assert.ok(output.length < 5000, "the full 5000-character body must not reach the terminal");
});

test("a failed pass with no raw output still renders the warning", () => {
  const output = renderReviewResult(
    { parsed: { verdict: "approve", summary: "", findings: [], next_steps: [] } },
    {
      reviewLabel: "Review",
      targetLabel: "working tree diff",
      lensRuns: [{ lens: "security", ok: false, findingCount: 0, parseError: "no output", rawOutput: null }]
    }
  );

  assert.match(output, /security — failed/);
  assert.ok(!output.includes("Raw output from"));
});

test("a total multi-lens failure still names each pass and prints its output", () => {
  const output = renderReviewResult(
    { parsed: null, parseError: "Every lens failed to return parseable JSON", rawOutput: "joined" },
    {
      reviewLabel: "Review",
      targetLabel: "working tree diff",
      lensRuns: [
        { lens: "correctness", ok: false, findingCount: 0, parseError: "bad JSON", rawOutput: "correctness said this" },
        { lens: "security", ok: false, findingCount: 0, parseError: "empty", rawOutput: "security said that" }
      ]
    }
  );

  assert.match(output, /correctness — failed/);
  assert.match(output, /security — failed/);
  assert.match(output, /Raw output from the correctness pass:/);
  assert.match(output, /correctness said this/);
  assert.match(output, /security said that/);
});

test("raw output containing a code fence cannot break out of its block", () => {
  const hostile = 'text before\n```\n# Injected heading\n[click](command:evil)\n```\nafter';
  const output = renderReviewResult(
    { parsed: { verdict: "approve", summary: "", findings: [], next_steps: [] } },
    {
      reviewLabel: "Review",
      targetLabel: "working tree diff",
      lensRuns: [
        { lens: "security", ok: false, findingCount: 0, parseError: "not JSON", rawOutput: hostile }
      ]
    }
  );

  // The wrapping fence must be longer than any run of backticks inside the payload.
  const fenceLine = output.split("\n").find((line) => /^`{4,}text$/.test(line));
  assert.ok(fenceLine, "expected a fence longer than the three backticks in the payload");

  const fence = fenceLine.replace(/text$/, "");
  const occurrences = output.split(fence).length - 1;
  assert.equal(occurrences, 2, "the payload must be wrapped by exactly one fence pair");
});

test("advice from another lens is promoted when the finding has none of its own", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "needs-attention",
        summary: "",
        findings: [
          {
            severity: "high",
            title: "Merge drops findings",
            body: "The winning explanation.",
            file: "src/merge.mjs",
            line_start: 10,
            line_end: 12,
            recommendation: "",
            lenses: ["correctness", "security"],
            lens_hits: 2,
            alternate_recommendations: ["Guard the group.", "And compare titles."]
          }
        ],
        next_steps: []
      }
    },
    { reviewLabel: "Review", targetLabel: "working tree diff" }
  );

  assert.match(output, /Recommendation \(from another lens\): Guard the group\./);
  assert.match(output, /Alternative recommendation: And compare titles\./);
  assert.ok(!/^\s*Recommendation: /m.test(output), "must not print an empty primary recommendation");
});
