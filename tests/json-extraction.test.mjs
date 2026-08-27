import test from "node:test";
import assert from "node:assert/strict";

import { parseStructuredOutput } from "../plugins/gemini/scripts/lib/gemini.mjs";

function fenced(inner) {
  return ["```json", inner, "```"].join("\n");
}

// Regression: extractJsonBlock closed on the first ``` it found. A review
// recommendation routinely contains a fenced code sample, so the payload has ``` inside
// it, and the JSON was cut off mid-string: "Unterminated string in JSON at position N".
test("a fenced code sample inside the payload does not truncate it", () => {
  const raw = fenced(
    JSON.stringify(
      {
        verdict: "needs-attention",
        summary: "fence handling",
        findings: [
          {
            severity: "medium",
            title: "fence marker is hardcoded to 3 characters",
            body: "details",
            file: "html_render.py",
            line_start: 363,
            line_end: 368,
            recommendation: "Use a regex:\n```python\nimport re\nre.match(r'^(```+)', s)\n```"
          }
        ],
        next_steps: []
      },
      null,
      2
    )
  );

  const result = parseStructuredOutput(raw, {});
  assert.equal(result.parseError, null);
  assert.equal(result.parsed.findings.length, 1);
  assert.match(result.parsed.findings[0].recommendation, /import re/);
});

test("raw newlines inside a string value are repaired rather than discarded", () => {
  const raw = fenced(
    [
      "{",
      '  "verdict": "needs-attention",',
      '  "summary": "ok",',
      '  "findings": [',
      '    { "severity": "medium", "title": "t", "body": "first line,',
      'second line.", "file": "a.py", "line_start": 1, "line_end": 2 }',
      "  ],",
      '  "next_steps": []',
      "}"
    ].join("\n")
  );

  const result = parseStructuredOutput(raw, {});
  assert.equal(result.parseError, null);
  assert.match(result.parseRepaired, /control characters/);
  // The content survives with the newline preserved as an escape.
  assert.equal(result.parsed.findings[0].body, "first line,\nsecond line.");
});

test("an already-valid payload is not marked as repaired", () => {
  const raw = fenced(JSON.stringify({ verdict: "approve", summary: "ok", findings: [], next_steps: [] }));
  const result = parseStructuredOutput(raw, {});

  assert.equal(result.parseError, null);
  assert.equal(result.parseRepaired, undefined);
});

test("an unfenced payload still parses", () => {
  const result = parseStructuredOutput(
    'Here is the review:\n{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}\n',
    {}
  );
  assert.equal(result.parseError, null);
  assert.equal(result.parsed.verdict, "approve");
});

test("escaped quotes inside strings are not mistaken for delimiters", () => {
  const payload = {
    verdict: "approve",
    summary: 'he said "fine" and left',
    findings: [],
    next_steps: []
  };
  const result = parseStructuredOutput(fenced(JSON.stringify(payload)), {});

  assert.equal(result.parseError, null);
  assert.equal(result.parsed.summary, 'he said "fine" and left');
  assert.equal(result.parseRepaired, undefined);
});

test("a payload broken beyond control characters still reports an error", () => {
  // Braces are present, so a block is found, but the value is unquoted garbage that no
  // control-character repair can fix.
  const result = parseStructuredOutput(fenced('{"verdict": approve, "summary": "ok"}'), {});
  assert.equal(result.parsed, null);
  assert.match(result.parseError, /does not parse/);
});

test("no JSON block at all is reported as such, not as a parse failure", () => {
  const result = parseStructuredOutput("I could not review this repository.", {});
  assert.equal(result.parsed, null);
  assert.match(result.parseError, /did not return a JSON block/);
});
