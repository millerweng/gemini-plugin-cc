# Changelog

## 1.4.4

- A turn that ends without a final message now says why. `stopReason` is the only field
  that carries the answer, and it was collected by `runAcpTurn` and then dropped when the
  payload was assembled — which left `status: 1` with an empty stderr, an empty stdout,
  and nothing anywhere to explain either. Reported from a workspace where eight of forty
  runs failed this way, every one of them inside a 28–44 second band while successful runs
  reached 426 seconds.
- The error text no longer sends readers to the job stderr. Under the ACP transport that
  stderr is empty in exactly this case, so the one instruction the message gave led
  nowhere. Each abnormal stop reason gets its own explanation instead; `max_tokens` says
  the budget went to reasoning and suggests narrowing the scope.
- `stopReason` is in the payload for reviews, tasks, and every lens of a multi-lens run,
  and a failed lens shows it on the `Lenses:` line.
- "did not return valid structured JSON" was misleading for these runs. Nothing was
  malformed — nothing was returned at all, which is a different problem with a different
  fix, and the wording sent people to look at output format.

## 1.4.3

- A merged finding takes its body and its recommendation from one chosen finding, rather
  than resolving each field separately. `??` respected an empty string but still fell
  through on a missing key, so a model that omitted `recommendation` produced the same
  mismatched pairing 1.4.1 and 1.4.2 each tried to close.
- The promoted body and recommendation are trimmed before the alternates are filtered
  against them. The alternates come from `uniqueText`, which trims, so text differing only
  by surrounding whitespace failed the comparison and was printed twice.
- Two lenses emitting the identical title merge even when that title is entirely
  stopwords. The guard that stops a vague title from swallowing specific ones was also
  stopping an exact match from merging with itself.

## 1.4.2

- An empty recommendation on the finding that supplied the body is respected instead of
  being filled in from another finding. `||` treated "this finding has no advice" as
  "look elsewhere", which reintroduced the mismatched pairing 1.4.1 set out to fix. The
  other finding's advice still appears among the alternates.
- When the promoted finding carries no advice of its own, an alternate is promoted in the
  wording — "Recommendation (from another lens)" — rather than printed as a footnote to a
  primary recommendation that is not there.

## 1.4.1

- A merged finding's recommendation comes from the same finding as its body. The body was
  taken from the longest explanation at the merged severity and the recommendation from
  the highest-severity finding, which are not always the same one — so a detailed account
  of one aspect of a bug could arrive with advice about another.
- Alternate recommendations are filtered by value rather than sliced by index, so advice
  from a second lens survives even when the promoted finding carried none of its own.
- Two-letter words are kept when tokenizing titles. `DB`, `UI`, `OS`, `IP`, `S3` and `PR`
  are words in this domain, and dropping them left titles that differ only by subsystem
  looking identical.
- Titles that use the same words except one no longer merge. "Missing DB lock" and
  "Missing UI lock" share two of three tokens and clear the overlap threshold, but the one
  word they disagree on is the entire content of the title. Two lenses restating one bug
  differ by more than a single word.
- A one-word title merges when both lenses use it. Requiring two shared words made
  "Deadlock", "XSS" and "OOM" unmergeable however exactly they matched, so two lenses
  naming the same well-known issue lost the corroboration signal.

## 1.4.0

- `/gemini:review` and `/gemini:adversarial-review` accept `--multi`, which runs the same
  diff through three narrow passes — `correctness`, `security`, `resilience` — and merges
  the findings. A single pass has to hold every concern at once, and the prompt's own
  "prefer one strong finding over several weak ones" rule then drops the rest; a
  medium-severity permission bug loses to a high-severity logic bug in the same file.
  Narrow the passes with `--multi=security,resilience`.
- Findings merge only when they come from different lenses, sit within five lines of each
  other, and their titles share at least two meaningful words covering 40% of the shorter
  title. Position alone was tried first and was wrong in both directions: it merged a
  logic bug and a permission bug that happened to land on adjacent lines, and it split the
  one bug two lenses actually agreed on because their line numbers differed by three.
- Merging is lossless. The wording a merge does not promote is kept as `Also reported as`
  and `Alternative recommendation`, so a wrong merge costs a duplicated line in the report
  rather than a deleted finding.
- Two findings from the same lens never merge. A lens reporting two problems a line apart
  found two problems, and collapsing them deleted one and labelled the survivor as
  corroborated when nothing corroborated it.
- A lens that returns unusable JSON no longer costs the whole review. The failed pass is
  named in the output and the passes that worked are still reported. The same now holds
  for a pass that throws: a rate limit on the third lens used to discard the two that had
  already finished and already cost their tokens.
- `--multi=` with an empty value runs every lens instead of silently falling back to a
  single pass. The empty string is falsy, so the truthiness check read an explicit request
  for several passes as no request at all.
- A group refuses a lens it already holds. The same-lens guard sits inside the pairwise
  comparison, which only ever sees the group's representative — so a wide finding from one
  lens could bridge two separate findings from another into one group, and the merge then
  deleted one of them. The guard prevented the direct case and missed the indirect one.
- A multi-lens review where every pass returns unparseable JSON now exits non-zero. The
  status was read with `??`, which passes a zero through, and a pass can finish its API
  call cleanly and still return JSON nothing can parse — CI was told the review passed
  when it had produced nothing.
- The payload's `threadId` is the first pass that actually produced one, not index 0. A
  rate limit on the first lens left it null and reported no resumable thread even though
  later passes had run fine.
- The payload carries `threadIds` for every pass. Each lens runs in its own ACP thread on
  purpose — sharing one would let a later pass read the earlier pass's conclusions and the
  passes would stop being independent — but only the first thread id was reachable.
- The passes run serially. The ACP broker serves one session at a time, so parallel passes
  fall back to a direct transport and start a Gemini process each, which reaches a
  rate limit that much faster.
- `parseArgs` gained optional-value flags. `--multi` had to work bare and with an inline
  list, and neither existing kind could do that: a boolean coerced `--multi=security` to
  `true` and silently dropped the lens list, while a value option made bare `--multi`
  swallow the following word of focus text.
- `alternate_bodies` reaches the report. The merge computed it and the renderer dropped it
  on the floor, which made "merging is lossless" false for the field most likely to differ
  between lenses — how each one describes the impact.
- A partial multi-lens review exits non-zero. Asking for three lenses and getting two is a
  degraded review; a green CI step after the security pass dropped out is worse than a red
  one. The rendered warning now says the exit will be non-zero.
- Failed passes keep their `rawOutput` in `lensRuns`, and the terminal prints it under the
  partial-failure warning, truncated at 2000 characters. It was discarded unless every
  pass failed, and then for a while it reached `--json` only — "JSON parse failed" does
  not say whether the model refused, ran out of tokens, or wrapped the block in prose, and
  needing a `--json` rerun to find out means paying for the review twice.
- `payload.gemini.status` keeps a successful `0` when the JSON is unparseable. It reports
  the API invocation, not the command outcome, and briefly shared the `||` that `exitStatus`
  needs — which told a downstream retry the network had failed when the model had only
  broken format. The two fields answer different questions and now read the status
  differently.
- Finding titles are tokenized with a Unicode-aware pattern, and scripts written without
  spaces between words are cut into character pairs. The old `[^a-z0-9\s]` stripped every
  non-ASCII character, which emptied any title not written in English — and an empty token
  set makes every comparison false, so merging was silently off for those reviews and the
  same finding appeared twice.
- The body promoted by a merge is chosen among findings that share the merged severity.
  Picking the longest body from the whole group let a low-severity finding's wordy
  explanation headline a critical one.
- Raw model output is fenced with a backtick run longer than any inside it. A fixed ```
  fence ended at the first ``` in the payload, and the rest of that untrusted text was
  rendered as markup.
- A review where every pass fails now lists the passes and prints each one's output. That
  path returned early, before the per-lens reporting, so the case with the least to show
  for itself showed the least about why.
- Known and not addressed: a `--background --multi` review collects the diff once, but a
  later pass calling Gemini's `codebase_investigator` reads the working tree as it is at
  that moment. Editing files or switching branches mid-review can leave a later pass
  reasoning about a tree its diff no longer describes. This is inherent to any review that
  outlives its diff, single-pass included, and pinning the tree would mean reviewing from
  a temporary worktree.
- `--multi=true` no longer aborts the run. `"false"` was coerced to a boolean and `"true"`
  was not, so it reached the lens lookup as a lens named `true`.
- Single-pass review is untouched. The lens directive interpolates to an empty string, so
  the prompt sent for a default review is byte-identical to the previous release's — 3133
  and 4126 bytes, unchanged. The placeholder sits on its own line and that line's newline
  replaces the blank line it appears to remove; `tests/prompt-lens-placeholder.test.mjs`
  pins the spacing, because reading the diff alone suggests a newline went missing and
  "restoring" it would add a third one.

## 1.3.0

- Reviews no longer ask Gemini to fetch the diff itself. A review runs in Gemini's plan
  mode so it cannot edit code, which also means it has no `run_shell_command` — the
  self-collect path was asking for something it could never do. One 62-file adversarial
  review spent 55 seconds reading whole files and exited with no output at all. When the
  diff does not fit, per-file diffs are now included until the byte budget runs out and
  the rest are listed under "Files Not Included", so findings rest on real diff text and
  the gaps are explicit.
- Removed the file-count gate entirely. It was 2, then 60, and both did the same damage:
  a diff well inside the byte budget was refused for touching one file too many. 62
  files was enough to trigger it. Per-file scaffolding is part of the diff, so bytes
  already account for it.
- A file whose own diff exceeds the budget is now named as omitted instead of vanishing.
  Git returns ENOBUFS for it, which was read as "no diff" and skipped, so the file
  appeared in neither the diff nor the omitted list and nothing recorded that it had
  never been reviewed.
- The diffstat and the omitted-file list are capped too. They are prompt text like
  everything else, and for a few hundred files they were larger than some of the diffs
  they described.
- `maxInlineDiffBytes` now reaches the collectors it is meant to bound; it was dropped
  on the way and truncation always used the default.

## 1.2.2

- Fixed a review payload being discarded when it contained a fenced code sample.
  `extractJsonBlock` matched non-greedily to the first closing ```` ``` ````, and a
  recommendation routinely embeds one, so the JSON was cut off mid-string and reported
  as `Unterminated string in JSON at position N`. Extraction now closes on the last
  fence and trusts the braces.
- Raw newlines and tabs inside JSON string values are escaped and re-parsed instead of
  throwing the payload away. Models emit them; JSON forbids them; the content means the
  same either way. The output says when a payload needed that repair.
- A reasoning trace longer than 12 entries is trimmed to its tail on failure paths,
  with a count of what was dropped. One failing run carried 267 entries, which buried
  the error they were printed to explain.

## 1.2.1

- Fixed a configured review base hiding every uncommitted change. The default was
  passed as `options.base`, which is how `--base` says "review a branch diff", and
  `resolveReviewTarget` returns on it before the dirty-tree check. So once a base was
  configured, a dirty checkout was reviewed as a branch diff: a worktree with 15
  modified files reported `fileCount: 0` and reviewed nothing. A configured default now
  only supplies the ref when a branch review is actually chosen. An explicit `--base`
  still forces a branch diff, and `--scope` still wins over both.

## 1.2.0

- Fixed `oauth-personal` always reporting "not authenticated". The probe looked for
  `~/.gemini/gemini-credentials.json`, a name Gemini CLI does not write; it now finds
  `oauth_creds.json` and still accepts the legacy name.
- `setup --verify` no longer refuses to run when the credential file is missing. A
  configured auth type always gets a real ACP handshake, and a successful handshake
  overrides the on-disk probe. Credential layout is Gemini CLI's business and it
  changes between releases, so a live session is the only trustworthy answer.
- `auth.detail` now names the credential file it found, or lists the names it probed.
- Added `/gemini:transfer`, which turns the current Claude Code session into a
  resumable Gemini session and prints the `gemini --session-file` command. Ported
  from codex-plugin-cc #374, which uses a Codex-only import RPC; this writes a
  native Gemini JSONL session instead. Harness markup (slash-command echoes,
  reminders) is stripped and tool payloads are collapsed unless
  `--include-tool-output` is passed.
- `SessionStart` now exports the transcript path so `/gemini:transfer` works without
  an explicit `--source`.
- Git commands no longer pass repository-derived arguments through a shell on
  Windows (codex-plugin-cc #447).
- Fixed `/gemini:review` failing with `Missing array next_steps` and dumping raw
  JSON instead of a rendered review. The prompts promised Gemini a schema it was
  never shown, and the renderer hard-rejected any response without `next_steps`.
  The real schema is now injected into the prompt, and `next_steps` is optional at
  render time. Upstream PR #5 by @petems, fixes upstream issue #4.
- Fixed the companion resolving its state directory into another plugin's data
  directory. `CLAUDE_PLUGIN_DATA` can point at the Codex plugin, whose state layout
  is identical, so this client would load Codex's broker session, dial the Codex
  app-server and fail every task with `unknown variant 'session/new'`. The
  directory is now checked for ownership, and a wrong-dialect broker reply falls
  back to the direct transport and forgets the endpoint. Fixes upstream issue #8,
  reported with a verified fix by @mplezier.

- Stopped sending small diffs down the self-collect path. `maxInlineFiles` was 2, so
  any change touching three files skipped the inline diff no matter how small it was —
  a 365-byte three-file diff qualified. Gemini was then told to fetch the diff itself
  with git, which an ACP session cannot do, and it returned `approve` inferred from
  diffstat line counts. The byte budget now decides; the file count is a loose guard
  at 60.
- When the diff genuinely does not fit, the prompt now forbids `approve` without
  evidence: Gemini must say which evidence it could not obtain and return
  `needs-attention`. The rendered output carries a warning naming the size that
  triggered it, so a verdict reached without the diff cannot pass for a reviewed one.

- Fixed an empty `- Parse error:` line. Callers build the failure message as
  `error?.message ?? stderr`, and `??` lets an empty string through, so a Gemini exit
  with no stderr reported no reason at all. Each branch now says what happened, and
  the renderer refuses to print an empty label. The caller's fallback object is also
  spread first, so a colliding key can no longer overwrite `parsed`/`parseError`.
- Added a per-workspace default review base: `/gemini:setup --set-review-base <ref>`
  (and `--clear-review-base`). Auto-detection follows `origin/HEAD`, which is the
  default branch — on a repository that merges into a long-lived integration branch
  the merge-base sits far back and every review silently covers everything since. The
  ref is validated when it is set rather than failing later inside `merge-base`.
- Reviews now name an auto-detected base along with the file count and merge-base
  whenever the range exceeds 40 files, and point at `--base` / `--set-review-base`. A
  base passed as a flag or read from config is never second-guessed.
- Added `--cwd <path>` to both review commands' `argument-hint`. The companion already
  accepted it, but nothing advertised it, so there was no visible way to review a
  worktree other than the one the session runs in.

- Commands that take no free-text arguments now reject unrecognised flags instead of
  quietly filing them as positionals. `setup --set-review-base <ref>` on a build
  without that flag printed a normal success report and did nothing, which is
  indistinguishable from it having worked. `setup` and `transfer` are strict; `review`,
  `task` and the job commands keep collecting unknown tokens, since free text is part
  of their contract. The error names every flag the command does accept.

- Reviews no longer print the reasoning trace when the result parsed. It restates the
  findings at length and costs tokens in whatever reads the output. `--show-reasoning`
  brings it back. Failure paths still print it unconditionally, since there it is the
  only evidence of what Gemini was doing.
- Fixed the configured review base never reaching the review. `executeReviewRun`
  re-resolved the target from the raw `--base` flag, so a base from config only
  affected the job title while the run itself fell back to auto-detection. The
  resolved base and where it came from are now passed through, which also makes the
  wide-range warning fire on the right runs instead of never.

- Progress lines are suppressed when stderr is not a terminal. They exist for a human
  watching a long run, but Claude Code captures stdout and stderr of a background run
  into one file, where dozens of `[gemini] Reasoning: …` lines bury the report they
  were meant to accompany. The job log still records every line, and `--progress`
  forces them back on.
- `setup` now prints the review base and the settings file it wrote to. Settings land
  under `CLAUDE_PLUGIN_DATA`, which Claude Code sets and a plain shell does not, so
  running the command by hand writes to the temp fallback and the plugin never reads
  it back — with the path shown, that is visible instead of looking like it worked.

- Linked git worktrees inherit the main checkout's review base. Every worktree is its
  own workspace — `git rev-parse --show-toplevel` returns the worktree's own path — so
  a base set on the checkout did not apply to worktrees created from it, and each
  short-lived worktree had to be configured again. An unset worktree now falls back to
  the main worktree's value; setting one on the worktree still wins, and unrelated
  repositories inherit nothing. `setup` names the checkout a base was inherited from.

## 1.0.0

- First public release as a standalone open-source repository.
- Fixed Codex leftover references in stop-review-gate prompt.
- Aligned model alias documentation with verified Gemini CLI model IDs.
- Added comprehensive README, test suite, CI/CD, and version management tooling.
- Consolidated general-purpose delegation into `/gemini:rescue` (removed standalone `/gemini:delegate`).
- Removed hardcoded `DEFAULT_MODEL` fallback; Gemini now picks its own default when `--model` is unset.
- Fixed remaining `!gemini` / `GEMINI_API_KEY` auth remediation strings in stop-gate and settings discovery.
- Hardened `.gitignore` to ignore `.gemini/` and `.env.*` (prevents accidental credential commits).
- Added `/reload-plugins` to README install flow (matches upstream baseline).
- Removed `--worktree` flag (ACP mode does not support Gemini's `-w` worktree creation).
- Fixed setup auth guidance to use `gemini auth` instead of nonexistent `!gemini auth`.
- Added ACP capability probe to readiness check (catches incompatible Gemini builds).
- Fixed stop-gate auth remediation to use `/gemini:setup` instead of generic `GEMINI_API_KEY` suggestion.
- Fixed stop-gate review sessions polluting rescue resume state (`--resume` no longer picks up gate threads).
- Fixed `setup --verify` hanging against live Gemini CLI (switched to async spawn, added `mcpServers: []`).
- Removed false ACP filesystem capabilities (client no longer advertises unimplemented `readTextFile`/`writeTextFile`).
- Added runtime test coverage for stop-gate exclusion, ACP capabilities, and verify connectivity.

## 0.1.0

- Initial version of the Gemini plugin for Claude Code.
- Codex-parity architecture: background jobs, workspace-keyed state,
  ACP broker for multiplexed concurrent sessions, Stop-hook review gate,
  `/gemini:setup`, `/gemini:rescue`, `/gemini:review`,
  `/gemini:adversarial-review`, `/gemini:status`, `/gemini:result`,
  `/gemini:cancel` commands.
- `gemini-rescue` subagent (Bash-only forwarder) with default `--yolo --sandbox`.
- Integrates with Google's Gemini CLI via `gemini --acp` (JSON-RPC 2.0 over stdio).
