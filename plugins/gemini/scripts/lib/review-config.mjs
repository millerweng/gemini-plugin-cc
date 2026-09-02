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
