---
description: Run a Gemini code review against local git state. Use when the user asks for a Gemini review by name — "gemini review", "review with gemini", "have Gemini look at this". Review-only; it never edits code.
argument-hint: '[--wait|--background] [--multi[=<lens,...>]] [--base <ref>] [--scope auto|working-tree|branch] [--cwd <path>] [--show-reasoning] [--show-files|--hide-files] [--max-diff-bytes <size>] [focus ...]'
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), Bash(wc:*), AskUserQuestion
---

Run a Gemini code review through the shared plugin runtime.

When to run this:
- The user named Gemini. A bare "review this" is not this command unless their own
  configuration says every review goes through Gemini.
- Never start one unprompted. A review spends Gemini quota and takes minutes, and
  `--multi` multiplies both by the number of lenses.

Gemini has no built-in reviewer, so this command is prompt-based like `/gemini:adversarial-review` but uses a less aggressive framing — a standard code review focused on material correctness and regression risk rather than challenging the implementation approach.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Gemini's output verbatim to the user.

Scope check (do this before the execution mode rules):
- Measure the diff in bytes: `git diff --binary <base>...HEAD | wc -c` for a branch review, `git diff --binary HEAD | wc -c` for a working tree.
- Past the diff budget the companion sends a partial diff, and the files that do not fit go unreviewed. The budget is 256 KB unless the workspace raised it; `/gemini:setup` reports the value in force.
- Raising it is one of the two ways out, alongside a narrower range: `--max-diff-bytes 512kb` for this run, or `/gemini:setup --set-max-diff-bytes 512kb` for every run. A much larger prompt can spend the whole turn on reasoning and return nothing, so raise it a step at a time rather than to a round number that sounds safe.
- Generated and copied files are the usual cause while the real change stays small — an installed plugin copy under `.claude`, build output, a lockfile. `git diff --stat` names them.
- When the diff is over that limit, the review needs a narrower scope. Carry that into the `AskUserQuestion` below as a third, recommended option: rerun with a tighter `--base <ref>`. Name the heaviest paths in the question so the choice is informed.

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
- Then use `AskUserQuestion` exactly once, with the two options below plus the narrower-scope option when the scope check called for it. Put the recommended option first and suffix its label with `(Recommended)`:
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

Coverage reporting:
- The companion prints `Warning:` lines above the findings whenever the run covered less than the whole change. Read them before presenting anything.
- `the diff was too large to send in full ... so it was truncated` — Gemini saw only part of the diff, and every path under `Files Not Included` went unreviewed.
- `base ... was auto-detected and the range covers N files` — the range may be wider than the change the user meant.
- `N of M lenses produced no usable result` — those lenses contributed nothing to the findings.
- When any of these appear, open with one sentence of your own naming the limit and what it leaves uncovered, then give the verbatim output. Presenting a partial review as a clean verdict is the failure this rule prevents.
- Then name a narrower rerun in that same sentence: a tighter `--base <ref>`, or `--scope working-tree` when only the uncommitted change matters. Add `--show-files` to it, which prints two explicit lists — the files the review covered, and the files it never saw.
- Write all of that as plain sentences in your reply. The run is finished, so there is nothing left to decide this turn and no question to open — whether to rerun is the user's call in their next message.
- A workspace can have those lists on for every review (`/gemini:setup --enable-show-files`), in which case they appear without the flag. `--hide-files` silences one such run.
- With no `Warning:` line, return the output verbatim and add nothing.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" review "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- Add nothing around it beyond the coverage sentence described above.
- A `Bash` call gets 600 seconds. If the review outruns that and Claude Code moves it to the background, there is no verdict and no findings yet — the review is unfinished, and a timeout notice is not a review.
- Wait it out with `node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" status <job-id> --wait --timeout-ms 3600000`, launched with `run_in_background: true`. A background call has no 600-second ceiling, and the harness re-invokes you when the wait exits. Drop the job id to wait on the one active job in this session.
- If that report still shows `queued` or `running`, read its `Liveness:` line before waiting again. `the log is still growing` means Gemini is working, so wait. `nothing new in the log for <time>` means it may be stuck. `the recorded process is gone` means it died without recording a result — report that and stop waiting.
- Otherwise present the result under the coverage rules above.
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
- The coverage reporting rules apply to the stored result too, whenever it is collected.
