---
name: graphical-audit
description: Audit a Graphical app, feature, or change for theme drift, one-off styling, undefined tokens, and inconsistent component treatments. Produce evidence and existing-theme mappings; apply repairs when requested. Use for finding or fixing styles that bypass the active theme.
---

# Audit Graphical theme drift

An audit is read-only unless the user asks for repairs. “Audit and fix” authorizes fixes within the requested scope; do not require another approval for each confirmed mapping. This is an evidence-based agent audit, not a claim that a deterministic linter has checked every rendered state.

## Establish the baseline

Resolve the requested screen, feature, change, or codebase scope. Read the app root `GUI.md`, `gui/theme-contract.md`, and `gui/foundations.md`. Locate these from the project root, not relative to this installed skill. Identify the active theme(s), current customizations, token aliases, primitive library, and shared component conventions. Generated `gui/themes.md` is a snapshot; current source is authoritative.

For a conversion follow-up, use the agreed target, component mappings, and documented intentional exceptions as the baseline. Inspect the conversion’s component coverage against the effective assignments linked from `gui/themes.md`, including variants, sizes, states, modes, and portals. Global tokens alone do not establish that a component matches. Unchanged library defaults are not intentional customizations merely because they are in current source. An agreed conversion includes finding and fixing remaining conversion gaps within that scope; an ordinary audit remains read-only unless repairs were requested.

Treat a named change as a change review: inspect its diff and relevant consumers, distinguishing introduced drift from pre-existing issues. A scoped UI task does not imply a whole-codebase audit. For a broad audit, state what was inspected and what remains; sampling does not establish complete coverage.

## Find and confirm drift

Read [drift rules](references/drift-rules.md). Search the scoped CSS, CSS modules, utilities/configuration, CSS-in-JS, JSX styles, shared components, and portal wiring as applicable. Exclude generated output, dependencies, and unrelated assets; inspect local theme/runtime source as the baseline. Locally owned vendor components may contain the root cause and are not automatically exempt.

Search results are candidates. For each candidate, trace its definition, cascade or state selector, and relevant consumers. Verify that it bypasses the current theme and that the proposed replacement actually exists and serves the same role. Read `gui/base-ui.md` or `gui/custom-components.md` when the issue involves component integration.

Consolidate repeated symptoms at their shared cause. Keep intentional customizations, valid aliases, layout geometry, artwork, and domain encodings separate from confirmed drift. Do not flag a value merely because it differs from the original exported preset or another theme. Do not create a new token to make an audit finding disappear.

## Report or repair

Use [the report format](references/report-format.md): scope, prioritized findings, existing-theme replacements, coverage, and verification. Cite current file/line evidence. Identify genuine theme gaps separately from fixes with known mappings. No findings is a valid result; never pad the report.

If repairs are requested, fix confirmed causes at their owning source, checking the reach of shared changes. Preserve behavior, supported modes/states, intentional exceptions, and dependency choices. Leave ambiguous semantic mappings as explicit gaps while completing independent fixes. Reinspect changed code and run the affected checks under `gui/verification.md` and the project’s policy.

Finish with what was fixed or found, what remains, and what was actually verified. Do not claim visual fidelity, rendered contrast, or complete coverage from a source search.
