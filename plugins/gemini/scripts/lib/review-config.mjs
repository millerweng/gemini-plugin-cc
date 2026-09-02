import { getMainWorktreeRoot } from "./git.mjs";
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
