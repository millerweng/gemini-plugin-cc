import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLensDirective,
  DEFAULT_LENS_IDS,
  getLens,
  mergeLensReviews,
  resolveLensIds
} from "../plugins/gemini/scripts/lib/review-lenses.mjs";

function finding(overrides = {}) {
  return {
    severity: "medium",
    title: "Something is wrong",
    body: "Body text.",
    file: "src/app.mjs",
    line_start: 10,
    line_end: 12,
    confidence: 0.6,
    recommendation: "Fix it.",
    ...overrides
  };
}

function run(lens, { findings = [], verdict = "needs-attention", summary = "s", next_steps = [] } = {}) {
  return { lens, parsed: { verdict, summary, findings, next_steps }, parseError: null, status: 0 };
}

test("resolveLensIds defaults to every lens when --multi is a bare flag", () => {
  assert.deepEqual(resolveLensIds(true), DEFAULT_LENS_IDS);
  assert.deepEqual(resolveLensIds(undefined), DEFAULT_LENS_IDS);
});

test("resolveLensIds accepts an inline list and drops duplicates", () => {
  assert.deepEqual(resolveLensIds("security,correctness,security"), ["security", "correctness"]);
});

test("an empty --multi= value still means every lens, not no lenses", () => {
  assert.deepEqual(resolveLensIds(""), DEFAULT_LENS_IDS);
});

test("resolveLensIds rejects an unknown lens instead of silently ignoring it", () => {
  assert.throws(() => resolveLensIds("perf"), /Unknown review lens perf/);
});

test("buildLensDirective is empty for a single-pass review", () => {
  assert.equal(buildLensDirective(null), "");
});

test("buildLensDirective names the pass so Gemini knows its scope", () => {
  const directive = buildLensDirective(getLens("security"));
  assert.match(directive, /<lens_focus>/);
  assert.match(directive, /"Security" pass/);
  assert.match(directive, /authentication and authorization/);
});

test("findings at the same location described the same way merge into one", () => {
  const { merged } = mergeLensReviews([
    run("correctness", { findings: [finding({ title: "Proximity merge drops findings" })] }),
    run("security", {
      findings: [finding({ title: "Proximity merge silently drops distinct findings", line_start: 11 })]
    })
  ]);

  assert.equal(merged.findings.length, 1);
  assert.deepEqual(merged.findings[0].lenses, ["correctness", "security"]);
  assert.equal(merged.findings[0].lens_hits, 2);
});

test("two findings from the same lens never merge, however close they sit", () => {
  const { merged } = mergeLensReviews([
    run("correctness", {
      findings: [
        finding({ title: "Off by one in the loop bound", line_start: 10, line_end: 10 }),
        finding({ title: "Off by one in the loop bound", line_start: 11, line_end: 11 })
      ]
    })
  ]);

  assert.equal(merged.findings.length, 2);
  assert.equal(merged.findings[0].lens_hits, 1);
});

test("unrelated findings on adjacent lines from different lenses stay separate", () => {
  const { merged } = mergeLensReviews([
    run("correctness", { findings: [finding({ title: "Off by one in the loop bound", line_start: 10 })] }),
    run("security", { findings: [finding({ title: "Missing tenant authorization check", line_start: 11 })] })
  ]);

  assert.equal(merged.findings.length, 2);
  assert.ok(merged.findings.every((entry) => entry.lens_hits === 1));
});

test("a merge keeps the wording it did not promote", () => {
  const { merged } = mergeLensReviews([
    run("correctness", {
      findings: [
        finding({
          severity: "critical",
          title: "Merge drops distinct findings",
          recommendation: "Never merge same-lens findings."
        })
      ]
    }),
    run("security", {
      findings: [
        finding({
          severity: "low",
          title: "Merge drops distinct security findings",
          recommendation: "Compare titles before merging."
        })
      ]
    })
  ]);

  const [entry] = merged.findings;
  assert.equal(entry.lens_hits, 2);
  assert.deepEqual(entry.alternate_titles, ["Merge drops distinct security findings"]);
  assert.deepEqual(entry.alternate_recommendations, ["Compare titles before merging."]);
});

test("generic filler words alone do not make two titles related", () => {
  const { merged } = mergeLensReviews([
    run("correctness", { findings: [finding({ title: "Potential issue with the parser" })] }),
    run("security", { findings: [finding({ title: "Possible problem in the handler", line_start: 11 })] })
  ]);
  assert.equal(merged.findings.length, 2);
});

test("a corroborated finding gets a confidence bump, capped at 1", () => {
  const { merged } = mergeLensReviews([
    run("correctness", { findings: [finding({ confidence: 0.6 })] }),
    run("security", { findings: [finding({ confidence: 0.5 })] })
  ]);
  assert.equal(merged.findings[0].confidence, 0.7);

  const { merged: capped } = mergeLensReviews([
    run("correctness", { findings: [finding({ confidence: 1 })] }),
    run("security", { findings: [finding({ confidence: 0.9 })] })
  ]);
  assert.equal(capped.findings[0].confidence, 1);
});

test("merging keeps the highest severity and the most detailed body", () => {
  const { merged } = mergeLensReviews([
    run("correctness", { findings: [finding({ severity: "low", body: "short" })] }),
    run("security", { findings: [finding({ severity: "critical", body: "a much longer explanation" })] })
  ]);

  assert.equal(merged.findings[0].severity, "critical");
  assert.equal(merged.findings[0].body, "a much longer explanation");
});

test("findings in different files stay separate", () => {
  const { merged } = mergeLensReviews([
    run("correctness", { findings: [finding({ file: "src/a.mjs" })] }),
    run("security", { findings: [finding({ file: "src/b.mjs" })] })
  ]);
  assert.equal(merged.findings.length, 2);
});

test("distant line ranges in the same file stay separate", () => {
  const { merged } = mergeLensReviews([
    run("correctness", { findings: [finding({ line_start: 10, line_end: 12 })] }),
    run("security", { findings: [finding({ line_start: 400, line_end: 402 })] })
  ]);
  assert.equal(merged.findings.length, 2);
});

test("corroborated findings sort above single-lens findings of equal severity", () => {
  const { merged } = mergeLensReviews([
    run("correctness", {
      findings: [
        finding({ severity: "high", file: "src/solo.mjs", line_start: 5, line_end: 5 }),
        finding({ severity: "high", file: "src/both.mjs", line_start: 50, line_end: 50 })
      ]
    }),
    run("security", {
      findings: [finding({ severity: "high", file: "src/both.mjs", line_start: 50, line_end: 50 })]
    })
  ]);

  assert.equal(merged.findings[0].file, "src/both.mjs");
  assert.equal(merged.findings[0].lens_hits, 2);
});

test("one bad lens does not discard the passes that worked", () => {
  const { merged, lensRuns, failedLenses } = mergeLensReviews([
    run("correctness", { findings: [finding()] }),
    { lens: "security", parsed: null, parseError: "not JSON", status: 1 },
    run("resilience", { findings: [finding({ file: "src/other.mjs" })] })
  ]);

  assert.equal(merged.findings.length, 2);
  assert.deepEqual(failedLenses, ["security"]);
  assert.equal(lensRuns.find((entry) => entry.lens === "security").ok, false);
  assert.equal(lensRuns.find((entry) => entry.lens === "correctness").findingCount, 1);
});

test("every lens failing yields no merged result", () => {
  const { merged, failedLenses } = mergeLensReviews([
    { lens: "correctness", parsed: null, parseError: "not JSON", status: 1 },
    { lens: "security", parsed: null, parseError: "empty", status: 1 }
  ]);

  assert.equal(merged, null);
  assert.deepEqual(failedLenses, ["correctness", "security"]);
});

test("verdict is needs-attention when any lens raises it", () => {
  const { merged } = mergeLensReviews([
    run("correctness", { verdict: "approve", findings: [] }),
    run("security", { verdict: "needs-attention", findings: [finding()] })
  ]);
  assert.equal(merged.verdict, "needs-attention");
});

test("verdict is approve only when every lens approves", () => {
  const { merged } = mergeLensReviews([
    run("correctness", { verdict: "approve", findings: [] }),
    run("security", { verdict: "approve", findings: [] })
  ]);
  assert.equal(merged.verdict, "approve");
  assert.deepEqual(merged.findings, []);
});

test("summaries are attributed per lens and next steps are deduped", () => {
  const { merged } = mergeLensReviews([
    run("correctness", { summary: "Logic looks fine.", next_steps: ["Add a test"] }),
    run("security", { summary: "Auth gap.", next_steps: ["Add a test", "Audit the endpoint"] })
  ]);

  assert.match(merged.summary, /^Correctness: Logic looks fine\./m);
  assert.match(merged.summary, /^Security: Auth gap\./m);
  assert.deepEqual(merged.next_steps, ["Add a test", "Audit the endpoint"]);
});

// Taken verbatim from the first real `--multi` run against this plugin's own diff.
// Two lenses reported one bug three lines and several word forms apart; the first
// similarity rule scored the pair 0.23 and left them split, which is exactly the
// corroboration signal multi-lens review exists to surface.
test("the two lenses that found one real bug in this plugin merge into one finding", () => {
  const { merged } = mergeLensReviews([
    run("correctness", {
      findings: [
        {
          severity: "high",
          title: "Proximity merge logic silently drops independent findings",
          body: "The isSameFinding function merges any two findings in the same file.",
          file: "plugins/gemini/scripts/lib/review-lenses.mjs",
          line_start: 120,
          line_end: 123,
          confidence: 0.9,
          recommendation: "Do not merge findings based purely on proximity."
        }
      ]
    }),
    run("resilience", {
      findings: [
        {
          severity: "critical",
          title: "Proximity-based finding merge silently destroys distinct bug reports",
          body: "The isSameFinding heuristic blindly clusters any findings within 2 lines.",
          file: "plugins/gemini/scripts/lib/review-lenses.mjs",
          line_start: 114,
          line_end: 117,
          confidence: 0.95,
          recommendation: "Never merge findings originating from the same lens."
        }
      ]
    })
  ]);

  assert.equal(merged.findings.length, 1);
  const [entry] = merged.findings;
  assert.equal(entry.severity, "critical");
  assert.equal(entry.lens_hits, 2);
  assert.deepEqual(entry.alternate_titles, ["Proximity merge logic silently drops independent findings"]);
  assert.deepEqual(entry.alternate_recommendations, ["Do not merge findings based purely on proximity."]);
});

test("distinct findings in the same file from that run stay distinct", () => {
  const { merged } = mergeLensReviews([
    run("correctness", {
      findings: [
        {
          severity: "medium",
          title: "Resuming a multi-lens review loses context for all but the first lens",
          body: "Only surfaces the first thread id.",
          file: "plugins/gemini/scripts/gemini-companion.mjs",
          line_start: 570,
          line_end: 570,
          confidence: 0.8,
          recommendation: "Return a unifying thread id."
        }
      ]
    }),
    run("resilience", {
      findings: [
        {
          severity: "high",
          title: "Serial multi-pass execution loses all results on API failure",
          body: "No try/catch around the pass.",
          file: "plugins/gemini/scripts/gemini-companion.mjs",
          line_start: 529,
          line_end: 544,
          confidence: 0.9,
          recommendation: "Wrap the pass in try/catch."
        }
      ]
    })
  ]);

  assert.equal(merged.findings.length, 2);
  assert.ok(merged.findings.every((entry) => entry.lens_hits === 1));
});

test("a plural and its singular count as the same word", () => {
  const { merged } = mergeLensReviews([
    run("correctness", { findings: [finding({ title: "Merge drops review findings" })] }),
    run("security", { findings: [finding({ title: "Merge drop review finding", line_start: 11 })] })
  ]);
  assert.equal(merged.findings.length, 1);
});

test("one shared word is not enough to merge", () => {
  const { merged } = mergeLensReviews([
    run("correctness", { findings: [finding({ title: "Merge loses data" })] }),
    run("security", { findings: [finding({ title: "Merge respects tenant boundaries", line_start: 11 })] })
  ]);
  assert.equal(merged.findings.length, 2);
});

// The same-lens guard inside isSameFinding only inspects the group's representative.
// A wide finding from one lens can act as a bridge that pulls two separate findings from
// another lens into one group, and the merge then deletes one of them — the loss the
// guard exists to prevent, reached the long way around.
test("a wide finding from one lens cannot bridge two findings from another", () => {
  const { merged } = mergeLensReviews([
    run("correctness", {
      findings: [
        finding({
          title: "Merge logic drops review findings",
          line_start: 10,
          line_end: 20,
          severity: "high"
        })
      ]
    }),
    run("resilience", {
      findings: [
        finding({ title: "Merge logic drops review findings early", line_start: 11, line_end: 11 }),
        finding({ title: "Merge logic drops review findings late", line_start: 15, line_end: 15 })
      ]
    })
  ]);

  // One resilience finding corroborates the correctness one; the other stands alone.
  assert.equal(merged.findings.length, 2);
  const lensCounts = merged.findings.map((entry) => entry.lens_hits).sort();
  assert.deepEqual(lensCounts, [1, 2]);

  // Neither resilience finding may vanish.
  const allText = JSON.stringify(merged.findings);
  assert.match(allText, /early/);
  assert.match(allText, /late/);
});

test("no merged group ever holds two findings from one lens", () => {
  const { merged } = mergeLensReviews([
    run("correctness", {
      findings: [
        finding({ title: "Shared merge failure mode", line_start: 10, line_end: 30 }),
        finding({ title: "Shared merge failure mode again", line_start: 12, line_end: 12 })
      ]
    }),
    run("security", {
      findings: [
        finding({ title: "Shared merge failure mode too", line_start: 11, line_end: 11 }),
        finding({ title: "Shared merge failure mode also", line_start: 13, line_end: 13 })
      ]
    })
  ]);

  for (const entry of merged.findings) {
    assert.equal(entry.lenses.length, new Set(entry.lenses).size);
    assert.ok(entry.lens_hits <= 2);
  }
  // Four findings in, nothing may be deleted: at most two pairs survive as merges.
  const totalReported = merged.findings.reduce(
    (sum, entry) => sum + 1 + (entry.alternate_titles?.length ?? 0),
    0
  );
  assert.equal(totalReported, 4);
});

test("titles in a language without spaces still merge", () => {
  const { merged } = mergeLensReviews([
    run("correctness", { findings: [finding({ title: "合并逻辑会丢弃发现" })] }),
    run("security", { findings: [finding({ title: "合并逻辑会静默丢弃发现", line_start: 11 })] })
  ]);

  assert.equal(merged.findings.length, 1);
  assert.equal(merged.findings[0].lens_hits, 2);
});

test("unrelated titles in that language still stay separate", () => {
  const { merged } = mergeLensReviews([
    run("correctness", { findings: [finding({ title: "合并逻辑会丢弃发现" })] }),
    run("security", { findings: [finding({ title: "权限校验缺失导致越权", line_start: 11 })] })
  ]);

  assert.equal(merged.findings.length, 2);
});

test("the primary body comes from a finding at the primary severity", () => {
  const { merged } = mergeLensReviews([
    run("correctness", {
      findings: [
        finding({
          severity: "low",
          title: "Merge drops review findings",
          body: "A very long but ultimately minor explanation that goes on and on."
        })
      ]
    }),
    run("security", {
      findings: [
        finding({
          severity: "critical",
          title: "Merge drops review findings silently",
          body: "Short but critical.",
          line_start: 11
        })
      ]
    })
  ]);

  const [entry] = merged.findings;
  assert.equal(entry.severity, "critical");
  assert.equal(entry.body, "Short but critical.");
  assert.ok(entry.alternate_bodies.some((body) => body.includes("minor explanation")));
});

test("two-letter acronyms survive tokenization and keep distinct bugs apart", () => {
  const { merged } = mergeLensReviews([
    run("correctness", { findings: [finding({ title: "Missing DB lock", line_start: 10, line_end: 10 })] }),
    run("security", { findings: [finding({ title: "Missing UI lock", line_start: 11, line_end: 11 })] })
  ]);

  assert.equal(merged.findings.length, 2, "DB and UI must not reduce to the same tokens");
});

test("the same acronym in both titles still merges", () => {
  const { merged } = mergeLensReviews([
    run("correctness", { findings: [finding({ title: "Missing DB lock", line_start: 10, line_end: 10 })] }),
    run("security", { findings: [finding({ title: "Missing DB lock check", line_start: 11, line_end: 11 })] })
  ]);

  assert.equal(merged.findings.length, 1);
  assert.equal(merged.findings[0].lens_hits, 2);
});

test("a one-word title merges when both lenses use it", () => {
  const { merged } = mergeLensReviews([
    run("correctness", { findings: [finding({ title: "Deadlock", line_start: 10, line_end: 10 })] }),
    run("resilience", { findings: [finding({ title: "Deadlock", line_start: 11, line_end: 11 })] })
  ]);

  assert.equal(merged.findings.length, 1);
  assert.equal(merged.findings[0].lens_hits, 2);
});

test("different one-word titles still stay apart", () => {
  const { merged } = mergeLensReviews([
    run("correctness", { findings: [finding({ title: "Deadlock", line_start: 10, line_end: 10 })] }),
    run("resilience", { findings: [finding({ title: "Livelock", line_start: 11, line_end: 11 })] })
  ]);

  assert.equal(merged.findings.length, 2);
});

test("the promoted recommendation comes from the same finding as the promoted body", () => {
  const { merged } = mergeLensReviews([
    run("correctness", {
      findings: [
        finding({
          severity: "high",
          title: "Merge drops review findings",
          body: "Short.",
          recommendation: "Advice tied to the short body."
        })
      ]
    }),
    run("security", {
      findings: [
        finding({
          severity: "high",
          title: "Merge drops review findings silently",
          body: "A considerably longer explanation of the same defect.",
          recommendation: "Advice tied to the long body.",
          line_start: 11
        })
      ]
    })
  ]);

  const [entry] = merged.findings;
  assert.match(entry.body, /considerably longer/);
  assert.equal(entry.recommendation, "Advice tied to the long body.");
  assert.deepEqual(entry.alternate_recommendations, ["Advice tied to the short body."]);
});

test("a recommendation is not lost when the promoted finding has none", () => {
  const { merged } = mergeLensReviews([
    run("correctness", {
      findings: [
        finding({
          severity: "high",
          title: "Merge drops review findings",
          body: "A long explanation that wins the body slot.",
          recommendation: ""
        })
      ]
    }),
    run("security", {
      findings: [
        finding({
          severity: "high",
          title: "Merge drops review findings silently",
          body: "Short.",
          recommendation: "The only advice anyone gave.",
          line_start: 11
        })
      ]
    })
  ]);

  const [entry] = merged.findings;
  const allAdvice = [entry.recommendation, ...(entry.alternate_recommendations ?? [])];
  assert.ok(allAdvice.includes("The only advice anyone gave."), "advice must survive somewhere");
});

// Reported twice by adversarial review as a wildcard that swallows nearby findings. The
// guard is at the top of titlesLookRelated and these pin it, because removing it would
// make an all-stopword title compare equal to everything within five lines.
test("a title that is entirely stopwords matches nothing", () => {
  const { merged } = mergeLensReviews([
    run("correctness", { findings: [finding({ title: "Potential issue", line_start: 10, line_end: 10 })] }),
    run("security", {
      findings: [finding({ title: "Tenant isolation bypass in the query builder", line_start: 11, line_end: 11 })]
    })
  ]);

  assert.equal(merged.findings.length, 2, "a vague title must not absorb a specific one");
  assert.ok(merged.findings.every((entry) => entry.lens_hits === 1));
});

test("two all-stopword titles do not merge with each other either", () => {
  const { merged } = mergeLensReviews([
    run("correctness", { findings: [finding({ title: "Potential issue", line_start: 10, line_end: 10 })] }),
    run("security", { findings: [finding({ title: "Possible problem", line_start: 11, line_end: 11 })] })
  ]);

  assert.equal(merged.findings.length, 2);
});

test("an empty recommendation on the promoted finding is not filled from another", () => {
  const { merged } = mergeLensReviews([
    run("correctness", {
      findings: [
        finding({
          severity: "high",
          title: "Merge drops review findings",
          body: "Short.",
          recommendation: "Advice belonging to the short body."
        })
      ]
    }),
    run("security", {
      findings: [
        finding({
          severity: "high",
          title: "Merge drops review findings silently",
          body: "A considerably longer explanation that wins the body slot.",
          recommendation: "",
          line_start: 11
        })
      ]
    })
  ]);

  const [entry] = merged.findings;
  assert.match(entry.body, /considerably longer/);
  assert.equal(entry.recommendation, "", "the promoted finding gave no advice; none may be invented for it");
  assert.deepEqual(entry.alternate_recommendations, ["Advice belonging to the short body."]);
});

test("an omitted recommendation key does not pull in another finding's advice", () => {
  const withoutKey = finding({
    severity: "high",
    title: "Merge drops review findings silently",
    body: "A considerably longer explanation that wins the body slot.",
    line_start: 11
  });
  delete withoutKey.recommendation;

  const { merged } = mergeLensReviews([
    run("correctness", {
      findings: [
        finding({
          severity: "high",
          title: "Merge drops review findings",
          body: "Short.",
          recommendation: "Advice belonging to the short body."
        })
      ]
    }),
    run("security", { findings: [withoutKey] })
  ]);

  const [entry] = merged.findings;
  assert.match(entry.body, /considerably longer/);
  assert.equal(entry.recommendation, "", "an absent key is not advice to borrow");
  assert.deepEqual(entry.alternate_recommendations, ["Advice belonging to the short body."]);
});

test("surrounding whitespace does not duplicate text into the alternates", () => {
  const { merged } = mergeLensReviews([
    run("correctness", {
      findings: [
        finding({
          severity: "high",
          title: "Merge drops review findings",
          body: "  A padded explanation that wins on length.  ",
          recommendation: "  Padded advice.  "
        })
      ]
    }),
    run("security", {
      findings: [
        finding({
          severity: "high",
          title: "Merge drops review findings silently",
          body: "Short.",
          recommendation: "Other advice.",
          line_start: 11
        })
      ]
    })
  ]);

  const [entry] = merged.findings;
  assert.equal(entry.body, "A padded explanation that wins on length.");
  assert.equal(entry.recommendation, "Padded advice.");
  assert.ok(
    !(entry.alternate_recommendations ?? []).includes("Padded advice."),
    "the promoted advice must not also appear as an alternate"
  );
  assert.ok(
    !(entry.alternate_bodies ?? []).includes("A padded explanation that wins on length."),
    "the promoted body must not also appear as an alternate"
  );
});

test("two lenses emitting the identical all-stopword title still merge", () => {
  const { merged } = mergeLensReviews([
    run("correctness", { findings: [finding({ title: "Potential issue", line_start: 10, line_end: 10 })] }),
    run("resilience", { findings: [finding({ title: "Potential issue", line_start: 11, line_end: 11 })] })
  ]);

  assert.equal(merged.findings.length, 1);
  assert.equal(merged.findings[0].lens_hits, 2);
});
