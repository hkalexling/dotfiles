---
description: Review or re-review an implementation and update a structured review file
argument-hint: "[plan/docs/handoff/review-file/context...]"
---
You are reviewing an implementation and writing or updating an actionable structured review file.

User-provided context, if any:

`$ARGUMENTS`

The user may provide any mix of:

- a plan file path;
- a handoff/status file path;
- an existing review file path for a follow-up re-review;
- supplementary documentation paths;
- implementation areas, branches, commits, or changed files;
- a plain-language description of what was implemented or what should be reviewed.

The input is intentionally flexible. Do not require a rigid argument format.

## Goal

Understand the intended work, inspect the implementation, validate behavior where feasible, and write a Markdown review file that the implementing developer can use directly.

If an existing review file is supplied, perform a follow-up re-review: read the developer's inline responses, verify the claimed fixes independently, check for new issues, and update that same review file with a follow-up section.

Do **not** modify implementation code. Only write or update the review file, unless the user explicitly asks for fixes.

## Determine review mode and inputs

1. Parse `$ARGUMENTS` as freeform context.
2. If a supplied token looks like a file path, read it when relevant.
3. Detect whether this is an initial review or a follow-up re-review:
   - Treat it as **re-review mode** if a supplied existing file appears to be a review file. Signals include:
     - the filename contains `review` or `REVIEW`;
     - the file contains review-like headings such as `Implementation Review`, `Findings`, `Critical`, `High`, `Medium`, `Low`, `Verification performed`, or inline developer response markers.
   - Treat it as **initial review mode** if no existing review file is supplied.
   - If multiple possible review files are supplied and the target is ambiguous, ask a concise clarifying question.
4. If a plan file is supplied, read it fully.
5. If no plan file is supplied, infer the intended behavior from the user's description and discover relevant project docs/files as needed.
6. If a handoff/status file is supplied, read it, but verify its claims independently.
7. If an existing review file is supplied, read it fully, including any developer inline replies and prior follow-up sections.
8. Follow links or references to other docs only when they are necessary to understand the intended behavior, product requirements, or architecture.
9. If the request is too ambiguous to review responsibly, ask a concise clarifying question instead of guessing.

## Initial review mode: choose the review file name

In initial review mode, choose the output review file path yourself. Prefer a concise Markdown file at the project root unless the project clearly keeps reviews elsewhere.

Naming guidance:

- If there is a plan file named `FOO_PLAN.md`, write `FOO_REVIEW.md`.
- If there is a handoff/status file named `FOO_HANDOFF.md`, write `FOO_REVIEW.md`.
- If there is a phase or feature name, derive `<FEATURE_OR_PHASE>_REVIEW.md`.
- If no better name is obvious, use `IMPLEMENTATION_REVIEW.md`.
- If the selected file already exists, overwrite it only if it is clearly the review for the same task and this is not re-review mode; otherwise choose a distinct name.

In your final response, report the review file path you wrote.

## Re-review mode: update the supplied review file

In re-review mode, the supplied existing review file is the output file.

Do not overwrite or replace the original review content. Preserve the original findings, developer inline replies, and previous follow-up review sections. Append a new follow-up section at the end of the file.

In re-review mode:

1. Read the existing review file fully.
2. Identify:
   - original findings;
   - developer inline replies;
   - claimed fixes;
   - disagreements or rejected findings;
   - verification claims;
   - any prior follow-up review conclusions.
3. Read referenced plan, handoff, status, and design documents needed to judge the findings.
4. Re-inspect the actual source code, tests, and generated artifacts as needed.
5. Do not trust inline replies, handoff claims, or old line numbers blindly. Verify against current files.
6. For each previous active finding, classify the current status as one of:
   - `Resolved` — the issue is fixed and verified;
   - `Partially resolved` — some but not all of the issue is fixed;
   - `Not resolved` — the issue still exists;
   - `No longer applicable` — the code or requirement changed so the finding no longer applies;
   - `Disagreement accepted` — the developer disagreed and the disagreement is valid;
   - `Disagreement rejected` — the developer disagreed but the issue is still valid.
7. Also inspect the current implementation for **new issues**, not only the previous findings.
8. Run relevant verification commands again where feasible.
9. Append a new follow-up section to the review file with:
   - verification performed;
   - status of previous findings;
   - remaining unresolved findings;
   - new findings, if any.

If all previous findings are resolved and no new issues are found, say that explicitly in the follow-up section.

In your final response, report the review file path updated and summarize how many previous findings were resolved, how many remain, and how many new findings were added.

## Review workflow

Use judgment rather than a checklist, but normally:

1. Identify the intended behavior from the plan, docs, handoff, review file, or user description.
2. Locate relevant git repository root(s), including nested repos if applicable.
3. Inspect implementation changes with `git status`, `git diff --stat`, and relevant file reads.
4. Inspect the changed code and nearby code paths enough to assess behavior.
5. Compare implementation against the stated plan, product docs, prior review findings, and project architecture.
6. Run relevant tests/checks when feasible. Prefer existing documented verification commands.
7. If a suspicious issue can be reproduced cheaply, run a small targeted command/script/test to confirm it.
8. If a command, tool, dependency, credential, or external service is unavailable, record that explicitly in the review. Do not fake or silently skip required verification.
9. Write or update the structured review file.

## Review focus

Prioritize:

- correctness bugs;
- incomplete implementation of explicit requirements;
- missed tests or weak verification;
- security, privacy, and safety issues;
- architectural drift from the plan or project principles;
- overengineering, unnecessary complexity, or brittle abstractions.

Avoid minor style nits unless they materially affect maintainability, clarity, or complexity.

## Required output structure for initial review mode

Write the review file as Markdown with this structure:

```markdown
# Implementation Review: <feature or work description>

## Review inputs

- User request/context: <brief summary>
- Plan/docs reviewed: <paths, or "None supplied">
- Handoff/status docs reviewed: <paths, if any>
- Implementation areas inspected: <brief list>

## Verification performed

- `<command>` → <result>
- `<command>` → <result>

If verification was blocked, say exactly why.

## Findings

## Critical

### Correctness

1. **<title>**

   File/lines:

   - `<path>:<line>`

   Problem: <what is wrong or missing>

   Why it matters: <impact>

   Evidence: <reproduction, observed output, or reasoning>

   Suggested fix: <actionable recommendation>

### Completeness

<findings or omit category if empty>

### Tests / Verification

<findings or omit category if empty>

### Security / Privacy / Safety

<findings or omit category if empty>

### Maintainability

<findings or omit category if empty>

### Overengineering / Complexity

<findings or omit category if empty>

## High

<same category ordering>

## Medium

<same category ordering>

## Low

<same category ordering>

## Notes / Non-blocking observations

<optional observations, explicitly non-blocking>
```

If a severity has no findings, omit that severity section except when including it would make the review clearer.

## Required output structure for re-review mode

Append a new section to the existing review file. Use the current date if available; otherwise use a clear iteration label.

```markdown
---

## Follow-up Review: <date or iteration label>

### Review inputs

- Existing review file: <path>
- Developer inline replies reviewed: <yes/no and brief notes>
- Additional plan/docs reviewed: <paths, or "None">
- Implementation areas re-inspected: <brief list>

### Verification performed

- `<command>` → <result>
- `<command>` → <result>

If verification was blocked, say exactly why.

### Status of previous findings

| Previous finding | Developer response | Reviewer status | Notes |
|---|---|---|---|
| High / Correctness — <title> | Claimed fixed | Resolved | Verified in `<path>` |
| Medium / Tests / Verification — <title> | Claimed fixed | Partially resolved | Missing <test or behavior> |

### Remaining or new findings

## Critical

### Correctness

1. **<title>**

   File/lines:

   - `<path>:<line>`

   Problem: <what is wrong or missing>

   Why it matters: <impact>

   Evidence: <reproduction, observed output, or reasoning>

   Suggested fix: <actionable recommendation>

## High

<same category ordering>

## Medium

<same category ordering>

## Low

<same category ordering>

### Notes / Non-blocking observations

<optional observations, explicitly non-blocking>
```

If there are no remaining or new findings, write:

```markdown
### Remaining or new findings

No remaining or new findings.
```

Resolved previous findings belong in the status table, not as active findings.

## Sorting and finding requirements

Sort active findings by severity first:

1. Critical
2. High
3. Medium
4. Low
5. Notes / Non-blocking observations

Within each severity, sort findings by category in this order:

1. Correctness
2. Completeness
3. Tests / Verification
4. Security / Privacy / Safety
5. Maintainability
6. Overengineering / Complexity

For each active finding, include:

- concise title;
- severity and category through the section placement;
- file path and line/reference when possible;
- what is wrong or missing;
- why it matters;
- evidence or reproduction when available;
- suggested fix.

Be concrete and evidence-driven. Do not rely solely on a handoff or developer inline reply. Make the review useful for the implementing developer to address directly.
