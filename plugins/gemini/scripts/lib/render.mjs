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
    recommendation: typeof source.recommendation === "string" ? source.recommendation.trim() : ""
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

function appendActiveJobsTable(lines, jobs) {
  lines.push("Active jobs:");
  lines.push("| Job | Kind | Status | Phase | Elapsed | Gemini Session ID | Summary | Actions |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const job of jobs) {
    const actions = [`/gemini:status ${job.id}`];
    if (job.status === "queued" || job.status === "running") {
      actions.push(`/gemini:cancel ${job.id}`);
    }
    lines.push(
      `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(job.elapsed ?? "")} | ${escapeMarkdownCell(job.threadId ?? "")} | ${escapeMarkdownCell(job.summary ?? "")} | ${actions.map((action) => `\`${action}\``).join("<br>")} |`
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

function appendReasoningSection(lines, reasoningSummary) {
  if (!Array.isArray(reasoningSummary) || reasoningSummary.length === 0) {
    return;
  }

  lines.push("", "Reasoning:");
  for (const section of reasoningSummary) {
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

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
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
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
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

  if (data.summary) {
    lines.push(data.summary, "");
  }

  if (data.inferred.length > 0) {
    lines.push(
      `Note: Gemini omitted ${data.inferred.map((field) => `\`${field}\``).join(", ")}; filled in from the rest of the response.`,
      ""
    );
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

  // The diff did not fit in the prompt, so Gemini had to fetch the changes itself. An
  // ACP session may not be able to, and a verdict reached without the diff is worth
  // nothing — say so rather than letting it read as a reviewed result.
  if (meta.inputMode === "self-collect") {
    const scale = [
      Number.isFinite(meta.fileCount) ? `${meta.fileCount} files` : null,
      Number.isFinite(meta.diffBytes) ? `${Math.ceil(meta.diffBytes / 1024)} KB of diff` : null
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(
      `Warning: the diff was too large to inline${scale ? ` (${scale})` : ""}, so Gemini was asked to read the changes itself. Confirm the findings reference real code before acting on this verdict.`,
      ""
    );
  }

  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      const lineSuffix = formatLineRange(finding);
      lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}${lineSuffix})`);
      if (finding.body) {
        lines.push(`  ${finding.body}`);
      }
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${finding.recommendation}`);
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
