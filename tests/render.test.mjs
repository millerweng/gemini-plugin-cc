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
