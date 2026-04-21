---
name: gemini-result-handling
description: Internal guidance for presenting Gemini helper output back to the user
user-invocable: false
---

# Gemini Result Handling

When the helper returns Gemini output:
- Present the output in whatever shape Gemini returned. For review prompts that is a verdict/summary/findings/next-steps structure; for general delegation (writing, research, analysis, explanation, brainstorming, code generation) it is free-form prose, lists, or whatever the task called for — do not force a verdict/findings frame onto non-review output.
- For review output specifically, present findings first and keep them ordered by severity.
- Use the file paths and line numbers exactly as the helper reports them.
- Preserve evidence boundaries. If Gemini marked something as an inference, uncertainty, or follow-up question, keep that distinction.
- Preserve output sections when the prompt asked for them, such as observed facts, inferences, open questions, touched files, or next steps.
- If there are no findings, say that explicitly and keep the residual-risk note brief.
- If Gemini made edits, say so explicitly and list the touched files when the helper provides them.

Handling empty output and failures:
- If the helper stdout contains the marker `Gemini did not return a final message.`, surface that line plainly to the user. Do not invent a replacement answer. Suggest a retry or `/gemini:status` if the task was substantive.
- If the helper stdout is a structured error envelope (`{"status":"error","message":"...","stderr":"..."}` or a line beginning with `Gemini companion failed:`), report the error message and the most actionable stderr lines verbatim, then stop. Do not attempt to execute the task yourself.
- If the helper reports a non-zero exit but no envelope, still surface the stderr and exit code. Silence is never a valid response from the rescue subagent.
- For `gemini:gemini-rescue`, do not turn a failed or incomplete Gemini run into a Claude-side implementation attempt. Report the failure and stop.
- For `gemini:gemini-rescue`, if Gemini was never successfully invoked, do not generate a substitute answer at all.
- If the helper reports malformed output or a failed Gemini run, include the most actionable stderr lines and stop there instead of guessing.
- If the helper reports that setup or authentication is required, direct the user to `/gemini:setup` and do not improvise alternate auth flows.

Review-specific safety:
- CRITICAL: After presenting review findings, STOP. Do not make any code changes. Do not fix any issues. You MUST explicitly ask the user which issues, if any, they want fixed before touching a single file. Auto-applying fixes from a review is strictly forbidden, even if the fix is obvious.
- This rule applies only to review output. For `/gemini:rescue` output that happens to contain code suggestions, follow normal delegation-output handling — surface what Gemini produced and let the user decide what to do next.
