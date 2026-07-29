# Hardcoded-string triage ledger

markers: 8

Candidates from the heuristic checks judged NOT violations. Quote the complete
string literal or JSX text node containing the grep match, not the matched
fragment; N is the occurrence count of that full string in the file at triage
time. If the occurrence count differs from N in either direction, the entry
is void — re-triage all occurrences and replace the entry. Prune when the
string is gone from the file entirely. The
category must be one of the verbatim categories listed in DOMAIN.md — no
invented categories.

The `markers:` line above is the authorized `TODO(i18n)` count for the repo
(rich-text markers + the named exceptions in DOMAIN.md). Each marker's
justification lives inline in its own comment — there is no ledger section
for markers.

Format: `file — "exact quoted string" — category — count N`

(empty — first reconcile run populates this)
