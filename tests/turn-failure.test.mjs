import assert from "node:assert/strict";
import test from "node:test";

import { describeTurnFailure, parseStructuredOutput } from "../plugins/gemini/scripts/lib/gemini.mjs";
import { renderReviewResult } from "../plugins/gemini/scripts/lib/render.mjs";

// Reproduces the shape of eight real failures collected from one workspace: status 1,
// empty stderr and stdout, reasoning present and cut mid-sentence. The old code turned
// that into "check the job stderr", and the stderr was empty.
function silentFailure(stopReason) {
  return {
    status: 1,
    stopReason,
    stderr: "",
    finalMessage: "",
    error: null,
    reasoningSummary: ["Reading packages/empyrean-langfuse/src/empyrean_"]
  };
}

test("a token-limit stop is explained instead of blamed on the stderr", () => {
  const message = describeTurnFailure(silentFailure("max_tokens"));
  assert.match(message, /output token limit/);
  assert.ok(!/stderr/i.test(message), "must not send the reader to an empty stderr");
});

test("each abnormal stop reason gets its own explanation", () => {
  assert.match(describeTurnFailure(silentFailure("refusal")), /declined/i);
  assert.match(describeTurnFailure(silentFailure("cancelled")), /cancelled/i);
  assert.match(describeTurnFailure(silentFailure("max_turn_requests")), /tool-call limit/i);
});

test("an unrecognized stop reason is still reported verbatim", () => {
  assert.match(describeTurnFailure(silentFailure("quota_exhausted")), /"quota_exhausted"/);
});

test("a normal stop with no output reports nothing rather than inventing a cause", () => {
  assert.equal(describeTurnFailure(silentFailure("end_turn")), null);
});

test("an explicit error outranks the stop reason", () => {
  const result = { ...silentFailure("max_tokens"), error: new Error("socket hang up") };
  assert.equal(describeTurnFailure(result), "socket hang up");
});

test("stderr is used only when there is nothing better", () => {
  const result = { status: 1, stopReason: "end_turn", stderr: "  gemini: command failed  ", error: null };
  assert.equal(describeTurnFailure(result), "gemini: command failed");
});

test("the parse error no longer points at the stderr", () => {
  const parsed = parseStructuredOutput("", { status: 1, failureMessage: "" });
  assert.ok(!/stderr/i.test(parsed.parseError), parsed.parseError);
  assert.match(parsed.parseError, /without a final message/);
});

test("an explained failure reaches the parse error instead of the generic text", () => {
  const explained = describeTurnFailure(silentFailure("max_tokens"));
  const parsed = parseStructuredOutput("", { status: 1, failureMessage: explained });
  assert.match(parsed.parseError, /output token limit/);
});

test("the rendered failure names the stop reason", () => {
  const output = renderReviewResult(
    { parsed: null, parseError: "Gemini reached its output token limit", rawOutput: "" },
    { reviewLabel: "Adversarial Review", targetLabel: "working tree diff", stopReason: "max_tokens" }
  );

  assert.match(output, /Stop reason: max_tokens/);
});

test("a normal stop reason is not printed as if it were a fault", () => {
  const output = renderReviewResult(
    { parsed: null, parseError: "something else", rawOutput: "" },
    { reviewLabel: "Review", targetLabel: "working tree diff", stopReason: "end_turn" }
  );

  assert.ok(!/Stop reason/.test(output));
});

test("a failed lens carries its stop reason onto the lens line", () => {
  const output = renderReviewResult(
    { parsed: { verdict: "approve", summary: "", findings: [], next_steps: [] } },
    {
      reviewLabel: "Review",
      targetLabel: "working tree diff",
      lensRuns: [
        { lens: "correctness", ok: true, findingCount: 2, parseError: null },
        { lens: "security", ok: false, findingCount: 0, parseError: "no output", stopReason: "max_tokens" }
      ]
    }
  );

  assert.match(output, /security — failed: max_tokens/);
});
