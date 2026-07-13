---
description: Address review comments — validate each item against code, present a fix plan, implement with inline responses in the review file
argument-hint: "<review-file-path>"
---
Your task is to address review comments in `$1`.

## 1. Understand the context

Read `$1` thoroughly. If it references plan documents, handoff files, or other design files by name, read those too — they contain the requirements the review is judging against.

Read the actual source files referenced in each review item (the files and line numbers). Do not trust the review's line numbers blindly — they may have shifted. Ground every item in the real code before forming a verdict.

## 2. Validate each review item

Go through each item one by one. For each:

- Cross-reference the file/line references against the actual source code.
- Determine whether the issue is **AGREE** (a real problem that needs fixing) or **DISAGREE** (not a valid issue).
- If you AGREE: identify the exact fix needed. Where the reviewer offered multiple fix options, state which you will take and justify briefly (cite the plan, documented behavior, or architectural consistency).
- If you DISAGREE: provide clear, grounded reasoning — not just preference. Cite the plan, the code, or documented behavior that contradicts the reviewer's claim.

## 3. Present the fix plan

Present a structured plan grouped by source file. Each entry should state:
- Which review item(s) it addresses
- Your verdict (AGREE/DISAGREE)
- The exact change planned
- Any judgment calls where you chose between reviewer-offered options

**IMPORTANT: Do NOT make any code changes yet. Stop here and wait for the user to confirm the plan.**

## 4. Implement fixes (after user confirms)

For each fix in the plan:

1. **Make the code change.** Prefer targeted `edit` calls over full-file `write`. Group non-overlapping changes in a single file into one `edit` call with multiple `edits[]` entries.

2. **Update the review file inline.** Immediately after each item in `$1`, add a response line starting with `*(AGREED — fixed)*` or `*(DISAGREED — see reasoning)*` followed by a short description of what you changed (or why you did not). This turns the review file into the resolution log.

3. **Verify incrementally.** After each logical group of changes, run the relevant checks. The exact verification commands and working directories should be inferred from the "Automated checks" or "Verification" section of the review file (if present), or from the project's documented verification commands (Makefiles, CI configs, pyproject.toml scripts, etc.).

## 5. Final verification

After all fixes are applied, run the full verification suite. Ensure everything passes. If anything fails, fix it before reporting completion.

## Guidelines

- **Keep the plan-verify-implement cycle tight.** Do not ask clarifying questions unless genuinely blocked by ambiguity in the review or code.
- **Run verification per-file or per-group**, not just at the end. Early detection saves time.
- **Update the review file as you go**, not in a batch at the end. This creates a clear audit trail.
- **If an item references a plan requirement**, cite the plan in your inline response so future readers understand the authority behind the fix.
- **For low-priority items** (overengineering, lint style, naming), be pragmatic but still address them — do not dismiss them as "not worth it."
