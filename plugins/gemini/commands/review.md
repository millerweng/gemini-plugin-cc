---
description: Run a Gemini code review against local git state
argument-hint: '[--wait|--background] [--multi[=<lens,...>]] [--base <ref>] [--scope auto|working-tree|branch] [--cwd <path>] [--show-reasoning] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a Gemini code review through the shared plugin runtime.
Gemini has no built-in reviewer, so this command is prompt-based like `/gemini:adversarial-review` but uses a less aggressive framing — a standard code review focused on material correctness and regression risk rather than challenging the implementation approach.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Gemini's output verbatim to the user.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run the review in the foreground.
- If the raw arguments include `--background`, do not ask. Run the review in a Claude background task.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant working-tree status is empty or the explicit branch diff is empty.
  - Recommend waiting only when the review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly.
- Do not strip `--wait` or `--background` yourself.
- Do not add extra review instructions or rewrite the user's intent.
- The companion script parses `--wait` and `--background`, but Claude Code's `Bash(..., run_in_background: true)` is what actually detaches the run.
- `/gemini:review` supports working-tree review, branch review, and `--base <ref>`.
- `/gemini:review` accepts extra focus text after the flags.
- If the user wants a stricter framing that challenges the implementation approach, they should use `/gemini:adversarial-review`.

Multi-lens review (`--multi`):
- Default is a single pass. `--multi` runs three narrower passes over the same diff — `correctness`, `security`, `resilience` — and merges the findings.
- A finding reported by more than one lens is marked as confirmed and sorted above single-lens findings of the same severity.
- Narrow the passes with an inline list, for example `--multi=security,resilience`.
- The passes run one after another, so a `--multi` review takes roughly as many times longer as it has lenses. Recommend `--background` whenever `--multi` is used, regardless of diff size.
- Pass `--multi` through to the companion script untouched.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" review "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:
- Launch the review with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" review "$ARGUMENTS"`,
  description: "Gemini review",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "Gemini review started in the background. Check `/gemini:status` for progress."
