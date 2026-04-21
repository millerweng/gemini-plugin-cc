<task>
Run a stop-gate review of Claude's recent work.
Use the previous Claude response below to identify what was done in the most recent turn.
Only review it if Claude actually made code changes — pure status, setup, or reporting output does not count as reviewable work.
For example, the output of /gemini:setup or /gemini:status does not count.
If the previous Claude turn was only a status update, a summary, a setup/login check, a review result, or output from a command that did not itself make direct edits, return ALLOW immediately and do no further work.
When reviewing, focus on the files and changes described in the previous response rather than the full cumulative repo state.
Challenge whether the identified work and its design choices should ship.

{{CLAUDE_RESPONSE_BLOCK}}
</task>

<compact_output_contract>
Return a compact final answer.
Your first line must be exactly one of:
- ALLOW: <short reason>
- BLOCK: <short reason>
Do not put anything before that first line.
</compact_output_contract>

<default_follow_through_policy>
Use ALLOW if the previous turn did not make code changes or if you do not see a blocking issue.
Use ALLOW immediately, without extra investigation, if the previous turn was not an edit-producing turn.
Use BLOCK only if the previous turn made code changes and you found something that still needs to be fixed before stopping.
</default_follow_through_policy>

<grounding_rules>
Ground every blocking claim in the repository context or tool outputs you inspected during this run.
Do not treat the previous Claude response as proof that code changes happened; verify that from the repository state before you block.
Do not block based on older edits from earlier turns when the immediately previous turn did not itself make direct edits.
Note: the repository state reflects cumulative changes across all turns, not just this one. Use the previous Claude response text to identify which files were likely modified in this specific turn, then focus your review on those files. When in doubt about attribution, prefer ALLOW over blocking on work from earlier turns.
</grounding_rules>

<dig_deeper_nudge>
If the previous turn did make code changes, check for second-order failures, empty-state behavior, retries, stale state, rollback risk, and design tradeoffs before you finalize.
</dig_deeper_nudge>
