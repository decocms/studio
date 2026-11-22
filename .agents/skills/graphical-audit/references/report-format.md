# Audit report

Scale the report to the scope. A single finding needs no elaborate document; a codebase audit needs enough evidence for another developer to apply the fixes.

Start with the inspected scope, active theme baseline, and whether the request includes repairs. For a change review, identify the compared changes and distinguish introduced drift from pre-existing issues.

| Impact | Location(s) | Evidence and effect | Existing-theme replacement | Status |
| --- | --- | --- | --- | --- |
| High / Medium / Low | Current `path:line` references | Current declaration or component treatment, violated contract, and practical effect | Verified token/component and why its role fits | Found / Fixed / Needs a decision |

One root cause gets one row, with confirmed occurrences grouped together. Prioritize shared causes and meaningful user impact. Do not include an unsupported location or a guessed replacement. Mark a missing suitable replacement as a theme gap and explain the decision needed.

After the findings, include:

- **Exceptions and gaps:** only material intentional treatments or unresolved decisions, with reasons.
- **Coverage:** files/surfaces, themes/modes, and states inspected; exclusions and sampled or uninspected areas. A whole-codebase search plus a few reads is partial coverage.
- **Verification:** actual commands or interactions and results; separate source checks, behavior checks, and manual visual review. Mark checks not performed as not verified.

For repairs, summarize the shared sources changed and any findings still open. For a clean audit, state that no confirmed drift was found within the inspected scope. Avoid a blanket pass verdict for uninspected behavior.
