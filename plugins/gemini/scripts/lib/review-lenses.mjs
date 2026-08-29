// Multi-lens review.
//
// A single review pass has to hold every concern at once, and the prompt's own
// calibration rules ("prefer one strong finding over several weak ones") then push
// Gemini to report the one issue it rates highest and drop the rest. Splitting the
// same diff across narrow lenses removes that competition: each pass only has one
// class of failure to look for, so a medium-severity permission bug is no longer
// crowded out by a high-severity logic bug in the same file.
//
// Running the same prompt N times would only average out sampling noise. The lenses
// below are deliberately disjoint so the passes disagree about what matters.

export const REVIEW_LENSES = [
  {
    id: "correctness",
    label: "Correctness",
    directive: [
      "Restrict this pass to correctness of the change itself.",
      "Look for logic errors, wrong conditions, off-by-one and boundary mistakes, unhandled",
      "error paths, invariants the change stops preserving, and behavior that only works on",
      "the happy path.",
      "Ignore security, concurrency, and rollback concerns in this pass — another pass covers them."
    ].join("\n")
  },
  {
    id: "security",
    label: "Security",
    directive: [
      "Restrict this pass to security and trust boundaries.",
      "Look for authentication and authorization gaps, tenant or user isolation failures,",
      "injection and deserialization risk, path traversal, secret and credential exposure,",
      "unsafe defaults, and input that crosses a trust boundary without validation.",
      "Ignore pure logic bugs and performance in this pass — another pass covers them."
    ].join("\n")
  },
  {
    id: "resilience",
    label: "Resilience",
    directive: [
      "Restrict this pass to failure behavior under real-world conditions.",
      "Look for race conditions, ordering assumptions, re-entrancy, idempotency gaps,",
      "partial-failure and retry handling, rollback and migration hazards, data loss or",
      "duplication, timeout and degraded-dependency behavior, and observability gaps that",
      "would hide a failure in production.",
      "Ignore stylistic and pure logic concerns in this pass — another pass covers them."
    ].join("\n")
  }
];

export const DEFAULT_LENS_IDS = REVIEW_LENSES.map((lens) => lens.id);

export function getLens(id) {
  return REVIEW_LENSES.find((lens) => lens.id === id) ?? null;
}

export function resolveLensIds(raw) {
  if (!raw || raw === true) return DEFAULT_LENS_IDS;
  const requested = String(raw)
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (requested.length === 0) return DEFAULT_LENS_IDS;

  const unknown = requested.filter((id) => !getLens(id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown review lens ${unknown.join(", ")}. Available lenses: ${DEFAULT_LENS_IDS.join(", ")}.`
    );
  }
  // Preserve the caller's order but drop duplicates, so `--multi security,security`
  // does not pay for the same pass twice.
  return [...new Set(requested)];
}

export function buildLensDirective(lens) {
  if (!lens) return "";
  return `\n<lens_focus>\nThis is the "${lens.label}" pass of a multi-pass review.\n${lens.directive}\n</lens_focus>\n`;
}

function severityRank(severity) {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
    default:
      return 4;
  }
}

function normalizeFilePath(file) {
  if (typeof file !== "string") return "";
  return file.trim().replace(/^\.\//, "");
}

function lineRange(finding) {
  const start = Number.isInteger(finding?.line_start) && finding.line_start > 0 ? finding.line_start : null;
  if (start === null) return null;
  const end =
    Number.isInteger(finding?.line_end) && finding.line_end >= start ? finding.line_end : start;
  return { start, end };
}

// Two lenses that find the same bug rarely agree on the exact line, so proximity has to
// allow some slack. Proximity alone is not enough to call two findings the same, though:
// a logic bug and a permission bug can sit on adjacent lines and have nothing to do with
// each other. Position decides whether two findings are close enough to compare; the
// titles decide whether they are actually about the same thing.
const LINE_PROXIMITY_SLACK = 5;

// Words that carry no signal about what a finding is about. Without this, "potential
// issue in handler" and "possible issue in parser" look related because they share
// "issue" and "in".
const TITLE_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "could", "do", "for", "from",
  "go", "has", "if", "in", "is", "issue", "it", "may", "might", "no", "not", "of", "on",
  "or", "possible", "potential", "problem", "so", "the", "there", "this", "to", "up",
  "we", "when", "with", "without"
]);

// Two letters is a real word in this domain — DB, UI, OS, IP, VM, PR, S3. Dropping them
// left "Missing DB lock" and "Missing UI lock" with the same two tokens, and near enough
// in one file they merged into a single finding that was neither.
const MIN_TITLE_WORD_LENGTH = 2;

// Two lenses writing about one bug pick different word forms for it — "drops findings"
// against "destroys distinct bug reports". Trimming a trailing plural is crude but it is
// what makes finding/findings and report/reports line up. Words ending in "ss" are left
// alone so "class" does not become "clas".
function stemWord(word) {
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) {
    return word.slice(0, -1);
  }
  return word;
}

// Scripts that do not put spaces between words. Splitting these on whitespace yields one
// token for the whole title, so they are cut into overlapping character pairs instead —
// the standard trick, and enough for two titles about one bug to share tokens.
const UNSPACED_SCRIPT = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/u;

function titleTokens(title) {
  if (typeof title !== "string") return new Set();

  // `[^a-z0-9\s]` used to strip every non-ASCII character, which emptied any title not
  // written in English and quietly turned merging off for it: an empty token set makes
  // every comparison false, so findings duplicated instead of merging.
  const cleaned = title.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ");
  const tokens = new Set();

  for (const word of cleaned.split(/\s+/)) {
    if (!word) continue;

    if (UNSPACED_SCRIPT.test(word)) {
      if (word.length === 1) {
        tokens.add(word);
        continue;
      }
      for (let index = 0; index + 1 < word.length; index += 1) {
        tokens.add(word.slice(index, index + 2));
      }
      continue;
    }

    if (word.length >= MIN_TITLE_WORD_LENGTH && !TITLE_STOPWORDS.has(word)) {
      tokens.add(stemWord(word));
    }
  }

  return tokens;
}

// At least two meaningful words in common, and they have to make up a real share of the
// shorter title. Jaccard was tried first and punished the pair it most needed to catch:
// two lenses describing one bug at different lengths scored 0.23 and stayed split.
// Measuring against the shorter title removes that length penalty; requiring two shared
// words keeps a single incidental match from merging anything.
const MIN_SHARED_TITLE_WORDS = 2;
const TITLE_OVERLAP_THRESHOLD = 0.4;

function titlesLookRelated(left, right) {
  const leftTokens = titleTokens(left);
  const rightTokens = titleTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return false;

  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) shared += 1;
  }

  // A title can reduce to one meaningful word — "Deadlock", "XSS", "OOM". Demanding two
  // shared words made those unmergeable however exactly they matched, so two lenses
  // naming the same well-known issue lost the corroboration entirely. Below the
  // threshold the shorter title has to be fully covered instead.
  const smaller = Math.min(leftTokens.size, rightTokens.size);
  if (smaller < MIN_SHARED_TITLE_WORDS) return shared === smaller;

  // Same number of words, agreeing on all but one: that one word is doing the
  // distinguishing. "Missing DB lock" and "Missing UI lock" share two of three tokens and
  // clear the overlap threshold comfortably, yet name different bugs — the subsystem is
  // the whole content of the title. Two lenses restating one bug almost always differ by
  // more than a single word, so this costs little and stops the substitution case.
  if (leftTokens.size === rightTokens.size && shared === leftTokens.size - 1) return false;

  if (shared < MIN_SHARED_TITLE_WORDS) return false;
  return shared / smaller >= TITLE_OVERLAP_THRESHOLD;
}

function positionsOverlap(left, right) {
  const leftRange = lineRange(left);
  const rightRange = lineRange(right);
  // Without line numbers there is no position to compare, so let the titles decide.
  if (!leftRange || !rightRange) return true;

  return (
    leftRange.start - LINE_PROXIMITY_SLACK <= rightRange.end &&
    rightRange.start - LINE_PROXIMITY_SLACK <= leftRange.end
  );
}

/**
 * Whether two findings, each tagged with the lens that produced it, describe one issue.
 *
 * Findings from the same lens never merge. A lens reporting two problems a line apart
 * means it found two problems; collapsing them would delete one of the two and label the
 * survivor as corroborated when nothing corroborated it.
 */
function isSameFinding(left, right) {
  if (left.lens === right.lens) return false;
  if (normalizeFilePath(left.finding.file) !== normalizeFilePath(right.finding.file)) return false;
  if (!positionsOverlap(left.finding, right.finding)) return false;
  return titlesLookRelated(left.finding.title, right.finding.title);
}

function clampConfidence(value) {
  if (!Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

// Independent passes landing on the same code is the strongest signal multi-lens
// review produces, and it is worth more than either pass's self-reported number.
// The bump is capped so a corroborated finding can reach but never exceed certainty.
function corroboratedConfidence(confidences, hitCount) {
  const known = confidences.map(clampConfidence).filter((value) => value !== null);
  if (known.length === 0) return null;
  const best = Math.max(...known);
  if (hitCount <= 1) return best;
  return clampConfidence(best + 0.1 * (hitCount - 1));
}

function uniqueText(values) {
  const seen = new Set();
  const kept = [];
  for (const value of values) {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(text);
  }
  return kept;
}

function mergeFindingGroup(group) {
  const sorted = [...group].sort(
    (left, right) => severityRank(left.finding.severity) - severityRank(right.finding.severity)
  );
  const primary = sorted[0].finding;
  const lenses = [...new Set(group.map((entry) => entry.lens))];

  // The longest body is a proxy for the most complete explanation; a one-line
  // restatement from a second lens should not replace a detailed one.
  //
  // Chosen only among findings that share the primary severity. Ranging over the whole
  // group let a low-severity finding's wordy body headline a critical one, so the report
  // paired a critical title and recommendation with the explanation of a minor issue.
  const primaryRank = severityRank(primary.severity);
  const richest = sorted
    .filter((entry) => severityRank(entry.finding.severity) === primaryRank)
    .sort(
      (left, right) => String(right.finding.body ?? "").length - String(left.finding.body ?? "").length
    )[0].finding;

  // Merging must never be lossy. Two lenses agreeing on a location can still be
  // describing it differently, and the second wording is often the one that names the
  // consequence the first one missed. Anything the merge does not promote to a primary
  // field is kept alongside so the report can still show it.
  const alternateTitles = uniqueText(sorted.slice(1).map((entry) => entry.finding.title)).filter(
    (title) => title.toLowerCase() !== String(primary.title ?? "").trim().toLowerCase()
  );
  const bodies = uniqueText(sorted.map((entry) => entry.finding.body));

  // The body comes from `richest`, so the recommendation has to as well. Taking it from
  // `primary` instead paired one finding's detailed explanation with another finding's
  // advice, and the two could be about different aspects of the same code.
  const primaryBody = richest.body ?? primary.body;
  const primaryRecommendation = richest.recommendation || primary.recommendation || "";
  const recommendations = uniqueText([
    primaryRecommendation,
    ...sorted.map((entry) => entry.finding.recommendation)
  ]);

  const merged = {
    ...primary,
    severity: primary.severity,
    body: primaryBody,
    recommendation: primaryRecommendation,
    lenses,
    lens_hits: lenses.length
  };

  if (alternateTitles.length > 0) {
    merged.alternate_titles = alternateTitles;
  }
  // Filtered by value, not by index. `primaryRecommendation` can be empty when neither
  // the richest nor the primary finding supplied one, and slicing from index 1 would then
  // drop a real recommendation that some other finding in the group did supply.
  const otherRecommendations = recommendations.filter(
    (text) => text !== merged.recommendation
  );
  if (otherRecommendations.length > 0) {
    merged.alternate_recommendations = otherRecommendations;
  }
  if (bodies.length > 1) {
    merged.alternate_bodies = bodies.filter((body) => body !== merged.body);
  }

  const confidence = corroboratedConfidence(
    group.map((entry) => entry.finding.confidence),
    lenses.length
  );
  if (confidence !== null) {
    merged.confidence = confidence;
  }

  return merged;
}

/**
 * Merge the per-lens review payloads into one review result.
 *
 * A lens that failed to parse is dropped from the merge but kept in `lensRuns`, so a
 * partial multi-review still returns the passes that did work instead of failing whole.
 */
export function mergeLensReviews(runs) {
  const lensRuns = runs.map((run) => ({
    lens: run.lens,
    label: getLens(run.lens)?.label ?? run.lens,
    ok: Boolean(run.parsed),
    parseError: run.parseError ?? null,
    status: run.status ?? null,
    summary: run.parsed?.summary ?? null,
    findingCount: Array.isArray(run.parsed?.findings) ? run.parsed.findings.length : 0
  }));

  const usable = runs.filter((run) => run.parsed);
  if (usable.length === 0) {
    return { merged: null, lensRuns, failedLenses: lensRuns.filter((run) => !run.ok).map((run) => run.lens) };
  }

  const groups = [];
  for (const run of usable) {
    const findings = Array.isArray(run.parsed.findings) ? run.parsed.findings : [];
    for (const finding of findings) {
      if (!finding || typeof finding !== "object") continue;
      const entry = { lens: run.lens, finding };
      // Compared against the group's first member only. Chaining through every member
      // would let A-B and B-C pull unrelated A and C into one group.
      //
      // The same-lens guard inside isSameFinding is not enough on its own: it only sees
      // the representative. If one lens reports a wide finding and a later lens reports
      // two separate bugs inside that range, both match the representative, both join
      // the group, and the merge then collapses two findings from one lens into one —
      // the exact loss the guard exists to prevent, arrived at indirectly. The group
      // itself has to refuse a lens it already holds.
      const group = groups.find(
        (candidate) =>
          isSameFinding(candidate[0], entry) && !candidate.some((member) => member.lens === entry.lens)
      );
      if (group) {
        group.push(entry);
      } else {
        groups.push([entry]);
      }
    }
  }

  const findings = groups
    .map(mergeFindingGroup)
    .sort((left, right) => {
      const bySeverity = severityRank(left.severity) - severityRank(right.severity);
      if (bySeverity !== 0) return bySeverity;
      // Corroborated findings first within a severity band.
      return (right.lens_hits ?? 1) - (left.lens_hits ?? 1);
    });

  const verdict = usable.some((run) => run.parsed.verdict === "needs-attention")
    ? "needs-attention"
    : "approve";

  const nextSteps = [
    ...new Set(
      usable
        .flatMap((run) => (Array.isArray(run.parsed.next_steps) ? run.parsed.next_steps : []))
        .filter((step) => typeof step === "string" && step.trim())
        .map((step) => step.trim())
    )
  ];

  const summary = usable
    .map((run) => {
      const label = getLens(run.lens)?.label ?? run.lens;
      const text = typeof run.parsed.summary === "string" ? run.parsed.summary.trim() : "";
      return text ? `${label}: ${text}` : null;
    })
    .filter(Boolean)
    .join("\n");

  return {
    merged: { verdict, summary, findings, next_steps: nextSteps },
    lensRuns,
    failedLenses: lensRuns.filter((run) => !run.ok).map((run) => run.lens)
  };
}
