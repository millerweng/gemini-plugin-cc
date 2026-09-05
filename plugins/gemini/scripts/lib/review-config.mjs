import path from "node:path";

import { DEFAULT_INLINE_DIFF_MAX_BYTES, getMainWorktreeRoot } from "./git.mjs";
import { getConfig } from "./state.mjs";

/**
 * A linked worktree is its own workspace, so settings do not carry over from the checkout
 * it was created from. Setting the same value in every short-lived worktree is busywork,
 * so an unset worktree falls back to the main worktree's value, and setting it on the
 * worktree still wins.
 *
 * Unset means missing, `null`, or `""`. That distinction is what lets a worktree turn a
 * boolean setting explicitly off without inheriting `true` back from the main checkout.
 */
function isSet(value) {
  return value !== undefined && value !== null && value !== "";
}

export function resolveInheritedConfigValue(cwd, workspaceRoot, key) {
  const own = getConfig(workspaceRoot)[key];
  if (isSet(own)) {
    return { value: own, inheritedFrom: null };
  }

  const mainRoot = getMainWorktreeRoot(cwd);
  if (!mainRoot || mainRoot === workspaceRoot) {
    return { value: null, inheritedFrom: null };
  }

  const inherited = getConfig(mainRoot)[key];
  return isSet(inherited) ? { value: inherited, inheritedFrom: mainRoot } : { value: null, inheritedFrom: null };
}

export function resolveConfiguredReviewBase(cwd, workspaceRoot) {
  const { value, inheritedFrom } = resolveInheritedConfigValue(cwd, workspaceRoot, "reviewBase");
  return { base: value ?? null, inheritedFrom };
}

/**
 * Whether reports list the files a review covered. Resolution order: the per-run flags
 * first, then the workspace setting, then off — so `--hide-files` can silence a run in a
 * workspace that has the setting turned on.
 */
export function resolveShowReviewFiles(cwd, workspaceRoot, options = {}) {
  if (options.showFilesFlag) {
    return { enabled: true, source: "flag", inheritedFrom: null };
  }
  if (options.hideFilesFlag) {
    return { enabled: false, source: "flag", inheritedFrom: null };
  }

  const { value, inheritedFrom } = resolveInheritedConfigValue(cwd, workspaceRoot, "showReviewFiles");
  if (value === null) {
    return { enabled: false, source: "default", inheritedFrom: null };
  }
  return { enabled: Boolean(value), source: "config", inheritedFrom };
}

// The byte budget that decides whether a diff is sent whole or in part. The default is
// deliberately conservative: a long prompt can spend the whole turn on reasoning and
// return nothing, which is worse than a truncated review that says it was truncated.
// Raising it trades that risk for coverage, so it is the user's call.
const BYTE_SUFFIXES = { b: 1, kb: 1024, k: 1024, mb: 1024 * 1024, m: 1024 * 1024 };

/**
 * Accepts raw bytes or a size suffix — `262144`, `512kb`, `1mb`. Throws rather than
 * falling back to the default, because a silently ignored budget looks like the flag
 * worked and only shows up as a review that truncated when it should not have.
 */
export function parseDiffByteBudget(input) {
  const raw = String(input ?? "").trim().toLowerCase().replace(/[_,\s]/g, "");
  const match = /^(\d+(?:\.\d+)?)(b|kb|k|mb|m)?$/.exec(raw);
  if (!match) {
    throw new Error(`Expected a byte count such as 262144, 512kb, or 1mb, got: ${input}`);
  }

  const bytes = Math.floor(Number(match[1]) * BYTE_SUFFIXES[match[2] ?? "b"]);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new Error(`A diff budget must be greater than zero, got: ${input}`);
  }
  return bytes;
}

export function formatDiffByteBudget(bytes) {
  if (!Number.isFinite(bytes)) {
    return "unknown";
  }
  if (bytes % (1024 * 1024) === 0) {
    return `${bytes / (1024 * 1024)} MB`;
  }
  if (bytes % 1024 === 0) {
    return `${bytes / 1024} KB`;
  }
  return `${bytes} bytes`;
}

export function resolveMaxInlineDiffBytes(cwd, workspaceRoot, options = {}) {
  if (options.flagValue !== undefined && options.flagValue !== null && options.flagValue !== false) {
    return { bytes: parseDiffByteBudget(options.flagValue), source: "flag", inheritedFrom: null };
  }

  const { value, inheritedFrom } = resolveInheritedConfigValue(cwd, workspaceRoot, "maxInlineDiffBytes");
  if (value === null) {
    return { bytes: DEFAULT_INLINE_DIFF_MAX_BYTES, source: "default", inheritedFrom: null };
  }
  // A hand-edited settings file can hold anything. Falling back beats throwing here,
  // because this runs on every review and not only when the value is being set.
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { bytes: DEFAULT_INLINE_DIFF_MAX_BYTES, source: "default", inheritedFrom: null };
  }
  return { bytes: Math.floor(parsed), source: "config", inheritedFrom };
}

// Paths kept out of every diff the review sees. The case this exists for is a source tree
// that also carries an installed copy of itself — `.claude/` and `.gemini/` plugin copies,
// vendored bundles, build output. Those triple the file count, and because the budget is
// spent on them the real source is what gets truncated away.
const MAX_EXCLUDE_PATTERNS = 64;

/**
 * Patterns are plain paths or globs relative to the repository root — `.claude`, `dist`,
 * `*.lock`. Git pathspec magic is rejected rather than passed through: `:(exclude)` is
 * added here, and letting a stored pattern carry its own prefix would let one turn into
 * an include and quietly widen the review instead of narrowing it.
 */
export function parseExcludePatterns(input) {
  const raw = Array.isArray(input) ? input : String(input ?? "").split(",");
  const patterns = [];

  for (const entry of raw) {
    const pattern = String(entry ?? "").trim().replace(/\/+$/, "");
    if (!pattern) {
      continue;
    }
    if (pattern.startsWith(":")) {
      throw new Error(`Git pathspec magic is not allowed in an exclude pattern: ${pattern}`);
    }
    if (path.isAbsolute(pattern) || pattern.startsWith("~")) {
      throw new Error(`An exclude pattern must be relative to the repository root: ${pattern}`);
    }
    if (pattern.split("/").includes("..")) {
      throw new Error(`An exclude pattern must stay inside the repository: ${pattern}`);
    }
    if (!patterns.includes(pattern)) {
      patterns.push(pattern);
    }
  }

  if (patterns.length > MAX_EXCLUDE_PATTERNS) {
    throw new Error(`At most ${MAX_EXCLUDE_PATTERNS} exclude patterns, got ${patterns.length}.`);
  }
  return patterns;
}

export function resolveExcludePatterns(cwd, workspaceRoot, options = {}) {
  if (options.noExcludeFlag) {
    return { patterns: [], source: "flag", inheritedFrom: null };
  }
  if (options.flagValue !== undefined && options.flagValue !== null && options.flagValue !== false) {
    return { patterns: parseExcludePatterns(options.flagValue), source: "flag", inheritedFrom: null };
  }

  const { value, inheritedFrom } = resolveInheritedConfigValue(cwd, workspaceRoot, "excludePaths");
  if (value === null) {
    return { patterns: [], source: "default", inheritedFrom: null };
  }
  try {
    // Runs on every review, so a hand-edited settings file degrades to "exclude nothing"
    // rather than breaking the command. Excluding nothing is the safe direction: it
    // reviews too much, never too little.
    const patterns = parseExcludePatterns(value);
    return patterns.length > 0
      ? { patterns, source: "config", inheritedFrom }
      : { patterns: [], source: "default", inheritedFrom: null };
  } catch {
    return { patterns: [], source: "default", inheritedFrom: null };
  }
}
