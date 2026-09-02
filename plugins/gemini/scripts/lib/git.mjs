import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;
const MAX_AGGREGATE_UNTRACKED_BYTES = 128 * 1024;
// The byte budget is the only thing that decides whether a diff fits in the prompt.
// There used to be a file-count gate as well — first 2, then 60 — and both did the same
// damage: a diff well inside the byte budget was declared too large because it touched
// one file too many. A 62-file review failed that way. Per-file scaffolding is part of
// the diff, so it is already counted in bytes.
//
// Exported so the `--max-diff-bytes` flag and the workspace setting that override it
// resolve against the same number. It is declared here rather than in review-config.mjs
// because that module imports this one, and pointing the dependency back would make the
// pair a cycle whose failure depends on which side is imported first.
export const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;

// Git is directly executable on Windows. Repository-derived arguments must never pass through a shell.
function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options, shell: false });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options, shell: false });
}

function listUniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

/**
 * Collects per-file diffs until the byte budget runs out, and reports which files did
 * not fit. A review runs in Gemini's plan mode, which has no shell, so "fetch the diff
 * yourself" is not a path it can take — partial evidence plus an explicit list of what
 * is missing beats no evidence at all.
 */
function collectTruncatedDiff(cwd, files, diffArgsFor, maxBytes) {
  const included = [];
  const omitted = [];
  let used = 0;

  for (const file of files) {
    if (omitted.length > 0) {
      // Once the budget is gone, stop spending git calls on files that cannot fit.
      omitted.push(file);
      continue;
    }
    const result = git(cwd, [...diffArgsFor(file), "--", file], { maxBuffer: maxBytes + 1 });
    if (result.error) {
      // Usually ENOBUFS: this one file's diff exceeds the whole budget. Treating that
      // as "no diff" would drop it from the diff and from the omitted list both,
      // leaving no trace that it was never reviewed.
      omitted.push(file);
      continue;
    }
    const body = result.stdout;
    if (!body) {
      // Genuinely nothing to show for this path — a mode-only change, for instance.
      continue;
    }
    if (used + body.length > maxBytes) {
      omitted.push(file);
      continue;
    }
    included.push(body);
    used += body.length;
  }

  return { body: included.join(""), omitted, bytes: used };
}

// Listing every omitted path is itself a large block of prompt. Enough names to be
// recognisable, then a count.
const MAX_OMITTED_FILES_LISTED = 40;
// A diffstat for hundreds of files is longer than some of the diffs it summarises.
const MAX_DIFFSTAT_LINES = 60;

function formatOmittedFiles(omitted) {
  if (omitted.length === 0) {
    return "";
  }
  const listed = omitted.slice(0, MAX_OMITTED_FILES_LISTED);
  const lines = [
    `${omitted.length} file(s) did not fit in the prompt and their diffs are NOT included below.`,
    "Do not draw conclusions about them; say so if they matter to a finding:",
    ...listed.map((file) => `- ${file}`)
  ];
  if (omitted.length > listed.length) {
    lines.push(`- ... and ${omitted.length - listed.length} more`);
  }
  return lines.join("\n");
}

function truncateDiffStat(diffStat) {
  const lines = diffStat.split("\n");
  if (lines.length <= MAX_DIFFSTAT_LINES) {
    return diffStat;
  }
  // The last line is git's own "N files changed" summary, worth keeping.
  const head = lines.slice(0, MAX_DIFFSTAT_LINES - 2);
  return [...head, `... ${lines.length - head.length - 1} more file(s) elided`, lines[lines.length - 1]].join("\n");
}

function normalizeMaxInlineDiffBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_BYTES;
  }
  return Math.floor(parsed);
}

function measureGitOutputBytes(cwd, args, maxBytes) {
  const result = git(cwd, args, { maxBuffer: maxBytes + 1 });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOBUFS") {
    return maxBytes + 1;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return Buffer.byteLength(result.stdout, "utf8");
}

function measureCombinedGitOutputBytes(cwd, argSets, maxBytes) {
  let totalBytes = 0;
  for (const args of argSets) {
    const remainingBytes = maxBytes - totalBytes;
    if (remainingBytes < 0) {
      return maxBytes + 1;
    }
    totalBytes += measureGitOutputBytes(cwd, args, remainingBytes);
    if (totalBytes > maxBytes) {
      return totalBytes;
    }
  }
  return totalBytes;
}

function buildBranchComparison(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  return {
    mergeBase,
    commitRange: `${mergeBase}..HEAD`,
    reviewRange: `${baseRef}...HEAD`
  };
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

/**
 * Working directory of the main worktree, which linked worktrees can inherit settings
 * from. `--git-common-dir` is the shared .git directory: a bare ".git" in the main
 * checkout, an absolute path to it from a linked worktree. Returns null when the repo
 * has no working tree to speak of (bare, or not a repo at all).
 */
export function getMainWorktreeRoot(cwd) {
  const result = git(cwd, ["rev-parse", "--git-common-dir"]);
  if (result.status !== 0) {
    return null;
  }
  const commonDir = result.stdout.trim();
  if (!commonDir) {
    return null;
  }
  const absoluteCommonDir = path.resolve(cwd, commonDir);
  if (path.basename(absoluteCommonDir) !== ".git") {
    return null;
  }
  return path.dirname(absoluteCommonDir);
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd) {
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const unstaged = gitChecked(cwd, ["diff", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const untracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"]).stdout.trim().split("\n").filter(Boolean);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  // A configured default only supplies the ref for a branch review. It must not act
  // like an explicit --base, or a dirty tree would be reviewed as a branch diff and
  // every uncommitted change would be invisible.
  const defaultBase = options.defaultBase ?? null;
  const state = getWorkingTreeState(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`
    );
  }

  if (requestedScope === "branch") {
    const branchBase = defaultBase ?? detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${branchBase}`,
      baseRef: branchBase,
      explicit: true
    };
  }

  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }

  const branchBase = defaultBase ?? detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${branchBase}`,
    baseRef: branchBase,
    explicit: Boolean(defaultBase)
  };
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

function formatUntrackedFile(cwd, relativePath) {
  const absolutePath = path.join(cwd, relativePath);
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (stat.isDirectory()) {
    return `### ${relativePath}\n(skipped: directory)`;
  }
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return `### ${relativePath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
  }

  let buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (!isProbablyText(buffer)) {
    return `### ${relativePath}\n(skipped: binary file)`;
  }

  return [`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n");
}

// An untracked file reaches Gemini as its whole content, and three things can stop that:
// a per-file skip (too big, binary, a directory, unreadable), or the aggregate budget
// running out. A skip marker still names the file in the prompt, but its content is not
// there — so for "was this reviewed?" it counts as omitted, exactly like a truncated one.
function formatUntrackedFiles(cwd, untrackedPaths, options = {}) {
  const aggregateMax = options.maxAggregateUntrackedBytes ?? MAX_AGGREGATE_UNTRACKED_BYTES;
  const parts = [];
  const omitted = [];
  let totalBytes = 0;
  let truncatedCount = 0;
  let truncatedRawBytes = 0;

  for (const filePath of untrackedPaths) {
    const formatted = formatUntrackedFile(cwd, filePath);
    const formattedBytes = Buffer.byteLength(formatted, "utf8");
    const isSkipMarker = formatted.includes("(skipped:");

    if (!isSkipMarker && totalBytes + formattedBytes > aggregateMax) {
      omitted.push(filePath);
      truncatedCount++;
      try {
        const stat = fs.statSync(path.join(cwd, filePath));
        truncatedRawBytes += stat.size;
      } catch {
        // Broken symlink or unreadable
      }
      continue;
    }

    parts.push(formatted);
    if (isSkipMarker) {
      omitted.push(filePath);
    } else {
      totalBytes += formattedBytes;
    }
  }

  if (truncatedCount > 0) {
    const kbLabel = Math.ceil(truncatedRawBytes / 1024);
    parts.push(
      `### ... ${truncatedCount} more untracked file${truncatedCount === 1 ? "" : "s"} not shown\n` +
      `(total ~${kbLabel} KB; use \`git add\` to stage specific files for full diff)`
    );
  }

  return { body: parts.join("\n\n"), omitted };
}

function collectWorkingTreeContext(cwd, state, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const status = gitChecked(cwd, ["status", "--short", "--untracked-files=all"]).stdout.trim();
  const changedFiles = listUniqueFiles(state.staged, state.unstaged, state.untracked);

  let parts;
  let omittedFiles;
  if (includeDiff) {
    const stagedDiff = gitChecked(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const unstagedDiff = gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const untracked = formatUntrackedFiles(cwd, state.untracked, { maxAggregateUntrackedBytes: options.maxAggregateUntrackedBytes });
    omittedFiles = untracked.omitted;
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff", stagedDiff),
      formatSection("Unstaged Diff", unstagedDiff),
      formatSection("Untracked Files", untracked.body)
    ];
  } else {
    const stagedStat = gitChecked(cwd, ["diff", "--shortstat", "--cached"]).stdout.trim();
    const unstagedStat = gitChecked(cwd, ["diff", "--shortstat"]).stdout.trim();
    const untracked = formatUntrackedFiles(cwd, state.untracked, { maxAggregateUntrackedBytes: options.maxAggregateUntrackedBytes });
    const tracked = listUniqueFiles(state.staged, state.unstaged);
    const truncated = collectTruncatedDiff(
      cwd,
      tracked,
      () => ["diff", "HEAD", "--binary", "--no-ext-diff", "--submodule=diff"],
      options.maxInlineDiffBytes ?? DEFAULT_INLINE_DIFF_MAX_BYTES
    );
    omittedFiles = listUniqueFiles(truncated.omitted, untracked.omitted);
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff Stat", stagedStat),
      formatSection("Unstaged Diff Stat", unstagedStat),
      formatSection("Diff (partial)", truncated.body),
      formatSection("Files Not Included", formatOmittedFiles(omittedFiles)),
      formatSection("Untracked Files", untracked.body)
    ];
  }

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: parts.join("\n"),
    changedFiles,
    omittedFiles
  };
}

function collectBranchContext(cwd, baseRef, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const comparison = options.comparison ?? buildBranchComparison(cwd, baseRef);
  const currentBranch = getCurrentBranch(cwd);
  const changedFiles = gitChecked(cwd, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", comparison.commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", comparison.commitRange]).stdout.trim();

  // Assigned by the truncated branch below; an inline diff omits nothing.
  let omittedFiles = [];

  const content = includeDiff
      ? [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection(
            "Branch Diff",
            gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange]).stdout
          )
        ].join("\n")
      : (() => {
          const truncated = collectTruncatedDiff(
            cwd,
            changedFiles,
            () => ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange],
            options.maxInlineDiffBytes ?? DEFAULT_INLINE_DIFF_MAX_BYTES
          );
          omittedFiles = truncated.omitted;
          return [
            formatSection("Commit Log", logOutput),
            formatSection("Diff Stat", truncateDiffStat(diffStat)),
            formatSection("Branch Diff (partial)", truncated.body),
            formatSection("Files Not Included", formatOmittedFiles(truncated.omitted))
          ].join("\n");
        })();

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    content,
    changedFiles,
    omittedFiles,
    comparison
  };
}

function buildAdversarialCollectionGuidance(options = {}) {
  if (options.includeDiff !== false) {
    return "Use the repository context below as primary evidence.";
  }

  // A review runs in Gemini's plan mode, which has no run_shell_command, so telling it
  // to fetch the diff itself is an instruction it cannot follow — one 62-file review
  // spent 55 seconds reading whole files and then exited with no output at all. The diff
  // below is therefore truncated rather than withheld: real evidence for the files that
  // fit, and an explicit list of the ones that did not.
  return [
    "The diff below is truncated — it did not all fit in this prompt.",
    "Everything shown is the real diff and is safe to reason about.",
    "Files whose diffs were left out are listed under 'Files Not Included'; you have no evidence about those.",
    "Do not infer anything about an omitted file, and do not treat the truncation itself as a finding.",
    "If an omitted file is material to a finding, say which one and why in the summary."
  ].join(" ");
}

export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const currentBranch = getCurrentBranch(repoRoot);
  const maxInlineDiffBytes = normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes);
  let details;
  let includeDiff;
  let diffBytes;

  if (target.mode === "working-tree") {
    const state = getWorkingTreeState(repoRoot);
    diffBytes = measureCombinedGitOutputBytes(
      repoRoot,
      [
        ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"],
        ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]
      ],
      maxInlineDiffBytes
    );
    includeDiff = options.includeDiff ?? diffBytes <= maxInlineDiffBytes;
    details = collectWorkingTreeContext(repoRoot, state, {
      includeDiff,
      maxInlineDiffBytes,
      maxAggregateUntrackedBytes: options.maxAggregateUntrackedBytes
    });
  } else {
    const comparison = buildBranchComparison(repoRoot, target.baseRef);
    const fileCount = gitChecked(repoRoot, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean).length;
    diffBytes = measureGitOutputBytes(
      repoRoot,
      ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange],
      maxInlineDiffBytes
    );
    includeDiff = options.includeDiff ?? diffBytes <= maxInlineDiffBytes;
    details = collectBranchContext(repoRoot, target.baseRef, { includeDiff, comparison, maxInlineDiffBytes });
  }

  // What changed is not what was reviewed. A truncated diff drops whole files, and an
  // untracked file can be skipped for its size or its type — so the reviewed set is the
  // changed set minus everything that never made it into the prompt.
  const omittedFiles = details.omittedFiles ?? [];
  const omittedSet = new Set(omittedFiles);
  const reviewedFiles = details.changedFiles.filter((file) => !omittedSet.has(file));

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    fileCount: details.changedFiles.length,
    diffBytes,
    // The budget that produced this inputMode. The report names it so a truncated review
    // says which limit it hit, not just that it hit one.
    maxInlineDiffBytes,
    inputMode: includeDiff ? "inline-diff" : "truncated-diff",
    collectionGuidance: buildAdversarialCollectionGuidance({ includeDiff }),
    ...details,
    omittedFiles,
    reviewedFiles
  };
}
