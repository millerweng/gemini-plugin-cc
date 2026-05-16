import test from "node:test";
import assert from "node:assert/strict";

import { renderReviewResult, renderStoredJobResult } from "../plugins/gemini/scripts/lib/render.mjs";

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
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

  assert.match(output, /Gemini returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
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
