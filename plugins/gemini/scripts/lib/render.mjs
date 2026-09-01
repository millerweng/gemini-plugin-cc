function severityRank(severity) {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    default:
      return 3;
  }
}

function formatLineRange(finding) {
  if (!finding.line_start) {
    return "";
  }
  if (!finding.line_end || finding.line_end === finding.line_start) {
    return `:${finding.line_start}`;
  }
  return `:${finding.line_start}-${finding.line_end}`;
}

// Showing the model a schema does not make it follow one. In practice Gemini returns
// findings with no `verdict`, or a summary with no `next_steps`. Dumping the raw JSON
// at the user over a missing label throws away a review it already paid for, so only
// bail out when the payload carries no review content at all. Everything else is
// filled in below and flagged as inferred.
function validateReviewResultShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Expected a top-level JSON object.";
  }
  const hasFindings = Array.isArray(data.findings);
  const hasSummary = typeof data.summary === "string" && data.summary.trim();
  if (!hasFindings && !hasSummary) {
    return "No `findings` array and no `summary` string — nothing reviewable in the payload.";
  }
  if (data.next_steps !== undefined && !Array.isArray(data.next_steps)) {
    return "Field `next_steps` must be an array when present.";
  }
  return null;
}

function normalizeReviewFinding(finding, index) {
  const source = finding && typeof finding === "object" && !Array.isArray(finding) ? finding : {};
  const lineStart = Number.isInteger(source.line_start) && source.line_start > 0 ? source.line_start : null;
  const lineEnd =
    Number.isInteger(source.line_end) && source.line_end > 0 && (!lineStart || source.line_end >= lineStart)
      ? source.line_end
      : lineStart;

  return {
    // Defaulting a missing severity to "low" invents a rating the model never gave,
    // and an unrated finding can just as easily be critical.
    severity:
      typeof source.severity === "string" && source.severity.trim() ? source.severity.trim() : "unrated",
    title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : `Finding ${index + 1}`,
    // Empty when absent so the renderer can skip the line instead of printing filler
    // above a recommendation that already carries the detail.
    body: typeof source.body === "string" && source.body.trim() ? source.body.trim() : "",
    file: typeof source.file === "string" && source.file.trim() ? source.file.trim() : "unknown",
    line_start: lineStart,
    line_end: lineEnd,
    recommendation: typeof source.recommendation === "string" ? source.recommendation.trim() : "",
    // Present only on a multi-lens review; the merge step attaches which passes
    // reported this finding, plus whatever wording it did not promote to a primary
    // field so the merge stays lossless.
    lenses: Array.isArray(source.lenses) ? source.lenses.filter((lens) => typeof lens === "string") : null,
    alternate_titles: Array.isArray(source.alternate_titles)
      ? source.alternate_titles.filter((title) => typeof title === "string" && title.trim())
      : [],
    alternate_recommendations: Array.isArray(source.alternate_recommendations)
      ? source.alternate_recommendations.filter((text) => typeof text === "string" && text.trim())
      : [],
    // The merge computes this; dropping it here made "merging is lossless" false for the
    // one field most likely to differ between lenses — the explanation of the impact.
    alternate_bodies: Array.isArray(source.alternate_bodies)
      ? source.alternate_bodies.filter((text) => typeof text === "string" && text.trim())
      : []
  };
}

function normalizeReviewResultData(data) {
  const inferred = [];

  const findings = (Array.isArray(data.findings) ? data.findings : []).map((finding, index) =>
    normalizeReviewFinding(finding, index)
  );
  if (!Array.isArray(data.findings)) {
    inferred.push("findings");
  }

  let verdict;
  if (typeof data.verdict === "string" && data.verdict.trim()) {
    verdict = data.verdict.trim();
  } else {
    // A review that raised findings is not an approval.
    verdict = findings.length > 0 ? "needs-attention" : "approve";
    inferred.push("verdict");
  }

  let summary;
  if (typeof data.summary === "string" && data.summary.trim()) {
    summary = data.summary.trim();
  } else {
    summary = "";
    inferred.push("summary");
  }

  return {
    verdict,
    summary,
    findings,
    next_steps: (Array.isArray(data.next_steps) ? data.next_steps : [])
      .filter((step) => typeof step === "string" && step.trim())
      .map((step) => step.trim()),
    inferred
  };
}

function isStructuredReviewStoredResult(storedJob) {
  const result = storedJob?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  return (
    Object.prototype.hasOwnProperty.call(result, "result") ||
    Object.prototype.hasOwnProperty.call(result, "parseError")
  );
}

function formatJobLine(job) {
  const parts = [job.id, `${job.status || "unknown"}`];
  if (job.kindLabel) {
    parts.push(job.kindLabel);
  }
  if (job.title) {
    parts.push(job.title);
  }
  return parts.join(" | ");
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function formatGeminiResumeCommand(job) {
  if (!job?.threadId) {
    return null;
  }
  return `gemini --resume ${job.threadId}`;
}

// `Status` and `Elapsed` both look identical for a run that is working and one that
// died half an hour ago, so the table carries its own liveness cell rather than making
// a reader scroll to the details block for the one field that separates them.
function formatLivenessCell(job) {
  if (job.processAlive === false) {
    return "dead — process gone";
  }
  if (job.stalled) {
    return `no log activity for ${job.lastUpdate}`;
  }
  if (job.lastUpdate) {
    return `alive — log grew ${job.lastUpdate} ago`;
  }
  return "";
}

function appendActiveJobsTable(lines, jobs) {
  lines.push("Active jobs:");
  lines.push("| Job | Kind | Status | Phase | Elapsed | Liveness | Gemini Session ID | Summary | Actions |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const job of jobs) {
    const actions = [`/gemini:status ${job.id}`];
    if (job.status === "queued" || job.status === "running") {
      actions.push(`/gemini:cancel ${job.id}`);
    }
    lines.push(
      `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(job.elapsed ?? "")} | ${escapeMarkdownCell(formatLivenessCell(job))} | ${escapeMarkdownCell(job.threadId ?? "")} | ${escapeMarkdownCell(job.summary ?? "")} | ${actions.map((action) => `\`${action}\``).join("<br>")} |`
    );
  }
}

function pushJobDetails(lines, job, options = {}) {
  lines.push(`- ${formatJobLine(job)}`);
  if (job.summary) {
    lines.push(`  Summary: ${job.summary}`);
  }
  if (job.phase) {
    lines.push(`  Phase: ${job.phase}`);
  }
  if (options.showElapsed && job.elapsed) {
    lines.push(`  Elapsed: ${job.elapsed}`);
  }
  // `Elapsed` climbs on its own and proves nothing. These two lines are the liveness
  // report: how long since the run last did something, and whether its process is still
  // there. Both only appear while the job claims to be active.
  if (options.showElapsed && job.lastUpdate) {
    lines.push(`  Last update: ${job.lastUpdate} ago`);
  }
  if (options.showElapsed && job.processAlive === false) {
    lines.push(
      `  Liveness: the recorded process is gone while the job still reads ${job.status}, so it died without writing a result. Treat the run as dead and start it again.`
    );
  } else if (options.showElapsed && job.stalled) {
    lines.push(
      `  Liveness: nothing new in the log for ${job.lastUpdate}, so the run may be stuck. Check the log below, and cancel it if it stays silent.`
    );
  } else if (options.showElapsed && job.lastUpdate) {
    lines.push("  Liveness: the log is still growing, so Gemini is working.");
  }
  if (options.showDuration && job.duration) {
    lines.push(`  Duration: ${job.duration}`);
  }
  if (job.threadId) {
    lines.push(`  Gemini session ID: ${job.threadId}`);
  }
  const resumeCommand = formatGeminiResumeCommand(job);
  if (resumeCommand) {
    lines.push(`  Resume in Gemini: ${resumeCommand}`);
  }
  if (job.logFile && options.showLog) {
    lines.push(`  Log: ${job.logFile}`);
  }
  if ((job.status === "queued" || job.status === "running") && options.showCancelHint) {
    lines.push(`  Cancel: /gemini:cancel ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && options.showResultHint) {
    lines.push(`  Result: /gemini:result ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && job.jobClass === "task" && job.write && options.showReviewHint) {
    lines.push("  Review changes: /gemini:review --wait");
    lines.push("  Stricter review: /gemini:adversarial-review --wait");
  }
  if (job.progressPreview?.length) {
    lines.push("  Progress:");
    for (const line of job.progressPreview) {
      lines.push(`    ${line}`);
    }
  }
}

// A failing run can carry hundreds of reasoning entries. They are the only evidence of
// what Gemini was doing, so they are kept — but the tail is what says how it ended, and
// an unbounded dump buries the error above it.
const MAX_REASONING_ENTRIES = 12;

function appendReasoningSection(lines, reasoningSummary) {
  if (!Array.isArray(reasoningSummary) || reasoningSummary.length === 0) {
    return;
  }

  const dropped = Math.max(0, reasoningSummary.length - MAX_REASONING_ENTRIES);
  const shown = dropped > 0 ? reasoningSummary.slice(-MAX_REASONING_ENTRIES) : reasoningSummary;

  lines.push("", "Reasoning:");
  if (dropped > 0) {
    lines.push(`- (${dropped} earlier entries omitted; last ${shown.length} shown)`);
  }
  for (const section of shown) {
    lines.push(`- ${section}`);
  }
}

export function renderSetupReport(report) {
  const lines = [
    "# Gemini Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${report.node.detail}`,
    `- npm: ${report.npm.detail}`,
    `- gemini: ${report.gemini.detail}`,
    `- auth: ${report.auth.detail}${report.auth.verified === true ? " (verified)" : report.auth.verified === false ? " (verification failed)" : " (unverified)"}`,
    `- session runtime: ${report.sessionRuntime.label}`,
    `- review gate: ${report.reviewGateEnabled ? "enabled" : "disabled"}`,
    `- review base: ${report.reviewBase ?? "auto-detected"}${report.reviewBaseInheritedFrom ? ` (inherited from ${report.reviewBaseInheritedFrom})` : ""}`,
    ...(report.configFile ? [`- settings file: ${report.configFile}`] : []),
    ""
  ];

  if (report.actionsTaken.length > 0) {
    lines.push("Actions taken:");
    for (const action of report.actionsTaken) {
      lines.push(`- ${action}`);
    }
    lines.push("");
  }

  if (report.nextSteps.length > 0) {
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

// A failed pass can return a whole file's worth of text. Enough to identify the failure
// mode belongs on the terminal; the rest stays in the JSON payload.
const RAW_OUTPUT_TERMINAL_LIMIT = 2000;

function truncateRawOutput(text) {
  const value = String(text);
  if (value.length <= RAW_OUTPUT_TERMINAL_LIMIT) return value;
  const omitted = value.length - RAW_OUTPUT_TERMINAL_LIMIT;
  return `${value.slice(0, RAW_OUTPUT_TERMINAL_LIMIT)}\n... [${omitted} more characters; full text is in the --json payload]`;
}

// The text being fenced is model output about an untrusted diff, and a fixed ```
// fence ends at the first ``` inside it — everything after that escapes the code block
// and is rendered as markup. The fence has to outrun the longest run of backticks in
// the content it wraps.
function fenceFor(text) {
  let longest = 0;
  for (const match of String(text).matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length);
  }
  return "`".repeat(Math.max(3, longest + 1));
}

function pushFencedBlock(lines, text, language = "text") {
  const fence = fenceFor(text);
  lines.push(`${fence}${language}`, text, fence);
}

// Shared so a total failure shows the same per-pass detail a partial one does. Keeping
// the raw output only on the partial path meant the case where every pass failed — the
// one that most needs the model's own words — printed the least.
function appendFailedLensOutput(lines, lensRuns) {
  for (const run of lensRuns) {
    if (run.ok || !run.rawOutput) continue;
    lines.push(`Raw output from the ${run.lens} pass:`, "");
    pushFencedBlock(lines, truncateRawOutput(run.rawOutput));
    lines.push("");
  }
}

export function renderReviewResult(parsedResult, meta) {
  if (!parsedResult.parsed) {
    // An empty parseError renders as a bare label with nothing after it, which tells
    // the reader nothing about what went wrong.
    const reason =
      typeof parsedResult.parseError === "string" && parsedResult.parseError.trim()
        ? parsedResult.parseError.trim()
        : "no reason reported — Gemini produced no final message and no error";
    const lines = [
      `# Gemini ${meta.reviewLabel}`,
      "",
      "Gemini did not return valid structured JSON.",
      "",
      `- Parse error: ${reason}`
    ];

    // Says why the turn ended. Without it a run that stopped at its token limit and one
    // that returned malformed JSON print the same thing, and only the second is about
    // output format — readers chased the wrong problem.
    if (typeof meta.stopReason === "string" && meta.stopReason && meta.stopReason !== "end_turn") {
      lines.push(`- Stop reason: ${meta.stopReason}`);
    }

    if (Array.isArray(meta.lensRuns) && meta.lensRuns.length > 0) {
      lines.push(
        "",
        `Lenses: ${meta.lensRuns
          .map((run) => (run.ok ? `${run.lens} (${run.findingCount})` : `${run.lens} — failed`))
          .join(", ")}`,
        ""
      );
      appendFailedLensOutput(lines, meta.lensRuns);
    } else if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "");
      pushFencedBlock(lines, parsedResult.rawOutput);
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const validationError = validateReviewResultShape(parsedResult.parsed);
  if (validationError) {
    const lines = [
      `# Gemini ${meta.reviewLabel}`,
      "",
      `Target: ${meta.targetLabel}`,
      "Gemini returned JSON with an unexpected review shape.",
      "",
      `- Validation error: ${validationError}`
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "");
      pushFencedBlock(lines, parsedResult.rawOutput);
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const data = normalizeReviewResultData(parsedResult.parsed);
  const findings = [...data.findings].sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  const lines = [
    `# Gemini ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    `Verdict: ${data.verdict}`,
    ""
  ];

  if (Array.isArray(meta.lensRuns) && meta.lensRuns.length > 0) {
    const passes = meta.lensRuns
      .map((run) => {
        if (run.ok) return `${run.lens} (${run.findingCount})`;
        const why =
          typeof run.stopReason === "string" && run.stopReason && run.stopReason !== "end_turn"
            ? `failed: ${run.stopReason}`
            : "failed";
        return `${run.lens} — ${why}`;
      })
      .join(", ");
    lines.push(`Lenses: ${passes}`, "");
    const failed = meta.lensRuns.filter((run) => !run.ok);
    if (failed.length > 0) {
      lines.push(
        `Warning: ${failed.length} of ${meta.lensRuns.length} lenses produced no usable result, so this review is partial and the command exits non-zero. Failed: ${failed
          .map((run) => `${run.lens} (${run.parseError ?? "no output"})`)
          .join("; ")}`,
        ""
      );

      // "JSON parse failed" does not say whether the model refused, ran out of tokens,
      // or wrapped the block in prose. The text it actually returned does, and requiring
      // a --json rerun to see it means re-paying for the review.
      appendFailedLensOutput(lines, failed);
    }
  }

  if (data.summary) {
    lines.push(data.summary, "");
  }

  if (data.inferred.length > 0) {
    lines.push(
      `Note: Gemini omitted ${data.inferred.map((field) => `\`${field}\``).join(", ")}; filled in from the rest of the response.`,
      ""
    );
  }

  if (parsedResult.parseRepaired) {
    lines.push(`Note: the JSON needed repair before it would parse — ${parsedResult.parseRepaired}.`, "");
  }

  // An auto-detected base follows origin/HEAD, which points at the repo's default
  // branch. On a long-lived integration branch that base can sit hundreds of commits
  // back, and the review then covers everything since — not the change at hand. Show
  // the range so a wrong base is visible instead of silently reviewed.
  if (meta.baseRef && meta.baseWasDetected && Number.isFinite(meta.fileCount) && meta.fileCount > 40) {
    lines.push(
      `Warning: base \`${meta.baseRef}\` was auto-detected and the range covers ${meta.fileCount} files${meta.mergeBase ? ` since merge-base ${meta.mergeBase.slice(0, 8)}` : ""}. If that is wider than the change you meant to review, rerun with \`--base <ref>\`, or set a default once with \`/gemini:setup --set-review-base <ref>\`.`,
      ""
    );
  }

  // The diff was truncated to fit. The findings are still grounded in real diff text,
  // but they cannot cover the files that were left out.
  if (meta.inputMode === "truncated-diff") {
    const scale = [
      Number.isFinite(meta.fileCount) ? `${meta.fileCount} files` : null,
      Number.isFinite(meta.diffBytes) ? `${Math.ceil(meta.diffBytes / 1024)} KB of diff` : null
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(
      `Warning: the diff was too large to send in full${scale ? ` (${scale})` : ""}, so it was truncated. Files listed under "Files Not Included" in the prompt were not reviewed at all.`,
      ""
    );
  }

  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      const lineSuffix = formatLineRange(finding);
      // Two independent lenses landing on the same code is the signal a multi-lens
      // review exists to produce, so it goes on the headline, not in a footnote.
      const lensSuffix =
        Array.isArray(finding.lenses) && finding.lenses.length > 0
          ? finding.lenses.length > 1
            ? ` [confirmed by ${finding.lenses.length} lenses: ${finding.lenses.join(", ")}]`
            : ` [${finding.lenses[0]}]`
          : "";
      lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}${lineSuffix})${lensSuffix}`);
      if (finding.body) {
        lines.push(`  ${finding.body}`);
      }
      // A second lens describing the same code differently is signal, not noise: it
      // often names the consequence the first wording left out.
      for (const title of finding.alternate_titles ?? []) {
        lines.push(`  Also reported as: ${title}`);
      }
      for (const body of finding.alternate_bodies ?? []) {
        lines.push(`  Alternative explanation: ${body}`);
      }
      // The promoted finding can carry no advice of its own while another lens in the
      // group had some. Labelling that one "Alternative" with no primary above it reads
      // like a footnote to nothing, so it is promoted in the wording instead.
      const alternates = finding.alternate_recommendations ?? [];
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${finding.recommendation}`);
        for (const recommendation of alternates) {
          lines.push(`  Alternative recommendation: ${recommendation}`);
        }
      } else if (alternates.length > 0) {
        lines.push(`  Recommendation (from another lens): ${alternates[0]}`);
        for (const recommendation of alternates.slice(1)) {
          lines.push(`  Alternative recommendation: ${recommendation}`);
        }
      }
    }
  }

  if (data.next_steps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of data.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  // On a review that parsed, the reasoning trace restates the findings at length and
  // costs tokens in whatever reads this. It stays available behind --show-reasoning,
  // and the failure paths above still print it unconditionally — there it is the only
  // evidence of what Gemini was doing.
  if (meta.showReasoning) {
    appendReasoningSection(lines, meta.reasoningSummary);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderNativeReviewResult(result, meta) {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const lines = [
    `# Gemini ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    ""
  ];

  if (stdout) {
    lines.push(stdout);
  } else if (result.status === 0) {
    lines.push("Gemini review completed without any stdout output.");
  } else {
    lines.push("Gemini review failed.");
  }

  if (stderr) {
    lines.push("", "stderr:", "", "```text", stderr, "```");
  }

  appendReasoningSection(lines, meta.reasoningSummary);

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderTaskResult(parsedResult, meta) {
  const rawOutput = typeof parsedResult?.rawOutput === "string" ? parsedResult.rawOutput : "";
  if (rawOutput) {
    return rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
  }

  const message = String(parsedResult?.failureMessage ?? "").trim() || "Gemini did not return a final message.";
  return `${message}\n`;
}

export function renderStatusReport(report) {
  const lines = [
    "# Gemini Status",
    "",
    `Session runtime: ${report.sessionRuntime.label}`,
    `Review gate: ${report.config.stopReviewGate ? "enabled" : "disabled"}`,
    ""
  ];

  if (report.running.length > 0) {
    appendActiveJobsTable(lines, report.running);
    lines.push("");
    lines.push("Live details:");
    for (const job of report.running) {
      pushJobDetails(lines, job, {
        showElapsed: true,
        showLog: true
      });
    }
    lines.push("");
  }

  if (report.latestFinished) {
    lines.push("Latest finished:");
    pushJobDetails(lines, report.latestFinished, {
      showDuration: true,
      showLog: report.latestFinished.status === "failed"
    });
    lines.push("");
  }

  if (report.recent.length > 0) {
    lines.push("Recent jobs:");
    for (const job of report.recent) {
      pushJobDetails(lines, job, {
        showDuration: true,
        showLog: job.status === "failed"
      });
    }
    lines.push("");
  } else if (report.running.length === 0 && !report.latestFinished) {
    lines.push("No jobs recorded yet.", "");
  }

  if (report.needsReview) {
    lines.push("The stop-time review gate is enabled.");
    lines.push("Ending the session will trigger a fresh Gemini adversarial review and block if it finds issues.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderJobStatusReport(job) {
  const lines = ["# Gemini Job Status", ""];
  pushJobDetails(lines, job, {
    showElapsed: job.status === "queued" || job.status === "running",
    showDuration: job.status !== "queued" && job.status !== "running",
    showLog: true,
    showCancelHint: true,
    showResultHint: true,
    showReviewHint: true
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStoredJobResult(job, storedJob) {
  const threadId = storedJob?.threadId ?? job.threadId ?? null;
  const resumeCommand = threadId ? `gemini --resume ${threadId}` : null;
  if (isStructuredReviewStoredResult(storedJob) && storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nGemini session ID: ${threadId}\nResume in Gemini: ${resumeCommand}\n`;
  }

  const rawOutput =
    (typeof storedJob?.result?.rawOutput === "string" && storedJob.result.rawOutput) ||
    (typeof storedJob?.result?.gemini?.stdout === "string" && storedJob.result.gemini.stdout) ||
    "";
  if (rawOutput) {
    const output = rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nGemini session ID: ${threadId}\nResume in Gemini: ${resumeCommand}\n`;
  }

  if (storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nGemini session ID: ${threadId}\nResume in Gemini: ${resumeCommand}\n`;
  }

  const lines = [
    `# ${job.title ?? "Gemini Result"}`,
    "",
    `Job: ${job.id}`,
    `Status: ${job.status}`
  ];

  if (threadId) {
    lines.push(`Gemini session ID: ${threadId}`);
    lines.push(`Resume in Gemini: ${resumeCommand}`);
  }

  if (job.summary) {
    lines.push(`Summary: ${job.summary}`);
  }

  if (job.errorMessage) {
    lines.push("", job.errorMessage);
  } else if (storedJob?.errorMessage) {
    lines.push("", storedJob.errorMessage);
  } else {
    lines.push("", "No captured result payload was stored for this job.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCancelReport(job) {
  const lines = [
    "# Gemini Cancel",
    "",
    `Cancelled ${job.id}.`,
    ""
  ];

  if (job.title) {
    lines.push(`- Title: ${job.title}`);
  }
  if (job.summary) {
    lines.push(`- Summary: ${job.summary}`);
  }
  lines.push("- Check `/gemini:status` for the updated queue.");

  return `${lines.join("\n").trimEnd()}\n`;
}
