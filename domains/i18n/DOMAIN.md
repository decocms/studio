# Domain: i18n

Owner: @viktormarinho

Internationalization of the Studio web UI (`apps/web/src`). Healthy means:
every user-facing string goes through `t()`, the pt-br dictionary fully mirrors
en, and the Portuguese reads like a person wrote it (see
[quality.md](./quality.md)) — not like machine output.

The full design rules live in the "Internationalization (i18n)" section of the
repo `CLAUDE.md`; this declaration is the enforceable subset.

## Scope

- `apps/web/src/**` — UI code and the i18n module (`apps/web/src/i18n/**`)
- `domains/i18n/triage.md` and `domains/i18n/quality-baseline` — the ONLY files
  under `domains/` the reconciler may write (state files). `DOMAIN.md` and
  `quality.md` are owner-only.
- NOT `packages/ui/**` (stays i18n-free by design; defaults are overridable via props)
- NOT server code (`apps/api/**`) — server-originated strings, emails, and
  seeded data deliberately stay English

## Invariants

### No hardcoded user-facing strings
JSX text, toasts, placeholders, `aria-label`s, tooltips, and empty states in
`apps/web/src` go through `t()` (`useT` from `apps/web/src/i18n/use-t.ts`).

The `// TODO(i18n): rich text` marker is valid ONLY on a string interleaved
with sibling JSX elements inside the same parent expression — i.e. it genuinely
cannot be one `t()` template. A valid marker comment starts with
`TODO(i18n): rich text` and carries its justification inline: a short note of
the JSX shape that disqualifies a `t()` template (e.g. "with `<code>` tags
mid-sentence"). The comment itself is the audit trail. A marker-adding PR
must quote, in its PR description, the parent JSX expression showing the
element sibling that disqualifies a `t()` template. A marker on a string that
could be a single `t()` template is itself a violation regardless of the
comment's text — the JSX is the arbiter, not the comment.

Known non-rich-text `TODO(i18n)` markers (exhaustive, owner-approved):
`components/settings/organization-form.tsx` (module-scope validation
messages), `routes/commerce-onboarding.tsx` (dynamic-or-translated error),
`components/sandbox/preview/visual-editor-prompt.tsx` (localizable instruction
text). Any other `TODO(i18n)` comment that does not start with
`TODO(i18n): rich text`, or a rich-text marker with no inline justification,
is a violation. Adding to the exception list is an owner edit to this file.

- Check (heuristic — candidates, not verdicts):
  `rg -n '(?:placeholder|title|aria-label|alt)="[A-Z][a-z]+ ' apps/web/src -g '*.tsx' -g '!**/i18n/**' -g '!**/*.test.tsx'`
  and
  `rg -n '>[A-Z][a-z]+ [a-z]' apps/web/src -g '*.tsx' -g '!**/i18n/**' -g '!**/*.test.tsx'`
- Check (heuristic — imperative toasts the JSX greps can't see; `*.ts` hooks
  are the main offenders):
  ``rg -n 'toast\.(success|error|info|warning)\(\s*["`][A-Z]' apps/web/src -g '*.ts' -g '*.tsx' -g '!**/i18n/**' -g '!**/*.test.*'``
- Check (marker count):
  `rg -c 'TODO\(i18n\)' apps/web/src | awk -F: '{s+=$2} END {print s+0}'`
  must EQUAL the `markers:` count in [triage.md](./triage.md), and every hit
  of `rg -n 'TODO\(i18n\)' apps/web/src` must either start with
  `TODO(i18n): rich text` or be one of the named exceptions above. Marker
  removed → decrement `markers:` (no justification needed). Marker added →
  the inline justification in the comment is the audit trail; increment in
  the same PR. The count never has slack.
- The heuristic greps above define the complete candidate set for a run — the
  reconciler acts only on their hits. Widening detection (new patterns, new
  greps) is an owner edit to this file.
- A candidate is NOT a violation only if it fits one of these categories,
  named verbatim in the triage reason: `test file` / `technical identifier` /
  `brand name` / `dev-only surface` (ONLY code behind `import.meta.env.DEV` or
  `process.env.NODE_ENV !== "production"` — no other flag or prop qualifies;
  admin views are user-facing and do NOT qualify) / `already fed by t()` /
  `TODO(i18n)-marked (valid per the marker rule)`. A candidate fitting no
  listed category IS a violation — the reconciler may not invent categories;
  a new category is an owner edit to this file.
- Category definitions: `technical identifier` = a string the user must
  type/copy verbatim or that names a wire/code entity — env var names, CLI
  commands, file paths, MIME types, HTTP methods, schema field names. Good:
  `"Content-Type"`, `"DATABASE_URL"`. Bad (IS a violation):
  `"Connection settings"`, `"Model provider"` — those describe, they don't
  identify. `brand name` = a proper noun of a product/company rendered as-is:
  "GitHub", "Cursor", "Model Context Protocol". Bad (IS a violation):
  `"Connect your GitHub account"` — the sentence around the brand is
  user-facing copy.
- Judged non-violations get recorded in [triage.md](./triage.md) as
  `file — "exact quoted string" — category — count N`. Quote the complete
  string literal or JSX text node containing the grep match, not the matched
  fragment; N is the occurrence count of that full string in the file at
  triage time. If the occurrence count differs from N in either direction,
  the entry is void — re-triage all occurrences and replace the entry. Prune
  when the string is gone from the file entirely. triage.md updates ride
  along with the run's substantive PR; a triage.md-only PR is allowed solely
  on a run that found zero violations but has void/stale entries to repair,
  and never while another open PR touches triage.md.

### pt-br mirrors en completely
Every `i18n/pt-br/<domain>.ts` declares
`satisfies Record<keyof typeof <enDomain>, string>`, so completeness is a
compile-time fact.

- Check: `bun run check` passes (the `satisfies` clauses make missing keys and
  un-mirrored files a compile error) AND
  `ls apps/web/src/i18n/en > /tmp/i18n-en.txt && ls apps/web/src/i18n/pt-br | diff /tmp/i18n-en.txt -`
  produces no output (this half only catches orphan pt-br files that mirror
  nothing) AND
  `rg --files-without-match 'satisfies Record<keyof typeof' apps/web/src/i18n/pt-br -g '*.ts' -g '!index.ts'`
  prints nothing — every pt-br domain file still declares its `satisfies`
  clause.

### Placeholders survive translation
A pt-br value only uses `{name}`-style placeholders that exist in its en
counterpart. Dropping one is legitimate (e.g. an English-only plural suffix
like `{plural}`); referencing one the caller doesn't supply renders literal
`{foo}` to the user.

- Check: `bun test apps/web/src/i18n`
  (`placeholder-parity.test.ts` asserts this per key).

### "Thread" in code, "chat" on screen
Dictionary VALUES never show the word "thread" to users — the user-facing noun
is "chat" (en) / "chat" (pt-br). Keys are code and may say `thread.*`.

- Check: `rg -in '": "[^"]*thread' apps/web/src/i18n/` — hits in values
  are violations. Known exceptions (exhaustive): `orgs.monitoring.keyPlaceholder`
  in en and pt-br (`thread_id` there names actual data, not the UI noun). Any
  other hit is a violation; new exceptions require the owner to add them here
  first.

### Language labels stay in their own language
"English" and "Português (Brasil)" option labels are never translated. They are
deliberately hardcoded outside the dictionaries and must never move into them.

- Check: `rg -n '"Português \(Brasil\)"' apps/web/src/views/settings/profile-preferences.tsx`
  returns exactly one hit, and `rg -n '"Inglês"|"Portuguese \(Brazil\)"' apps/web/src`
  returns nothing. If the first grep returns zero hits or errors because the
  file no longer exists, the component moved: stale-declaration condition —
  stop and flag the owner to update this path.
  More than one hit is a violation (duplicate label), not a stale-declaration
  condition. Never create or move the label string to satisfy the check.

### Translation quality (subjective — see quality.md)
pt-br values follow [quality.md](./quality.md): informal-professional "você"
tone, technical terms kept in English, no literal calques. quality.md carries
the good/bad examples that define the boundary.

- Check: baseline is the commit SHA in `domains/i18n/quality-baseline`.
  Review only pt-br values changed in
  `git fetch origin main && git diff $(cat domains/i18n/quality-baseline)..origin/main -- apps/web/src/i18n/pt-br/`
  — the audit range is baseline→`origin/main`, never the working tree.
  If the audit range contains no pt-br changes, skip the quality audit and do
  not touch the baseline file. If it contains changes: a PR that ships other
  work also bumps the baseline to the audited HEAD SHA; a clean audit with no
  other work to ship opens a baseline-bump-only PR (single-file diff) — never
  while an open PR already touches `domains/i18n/quality-baseline`, and never
  twice for the same range: a new bump is justified only after the baseline
  file has changed on `main` AND pt-br changed after that. If the SHA in the
  file is unresolvable in the checkout, stop and flag the owner — never
  substitute a guessed range. The baseline is always a commit on the default
  branch that the audit ran against; it never includes the PR's own commits —
  the PR's own pt-br additions fall into the next run's audit range. File
  missing → audit the full dictionary once and create the file in the same
  PR. Values behind the baseline are settled — never re-audit them.
- Only flag a value that violates an enforceable quality.md rule (see its
  header for what is enforceable). "Matches a pattern" means the same rule as
  a bad-example cell or an enforceable bullet — not merely similar phrasing.
  "Could sound nicer" is NOT a violation.

## Health

This domain has no runtime surface; `bun run check` is the health check
(translation completeness is a compile error).

## Runbook

- `bun run check` fails after a dictionary edit → a pt-br file is missing or
  has extra keys vs its en counterpart; the `satisfies` error names them.
- New en domain file → mirror it in `pt-br/` and spread BOTH in their
  `index.ts` files.
- A string can't be a single template (JSX interleaved) → mark
  `// TODO(i18n): rich text` and leave it; do not force it.

## Tools

- `rg`, `bun run check`, `bun run fmt`, `bun run lint`, `bun test`
- `git`, `gh` (branch, push, PR)
- No MCP connections, no production access — this domain is fully static.

## Limits

- Never touch `packages/ui/**` or server code to "internationalize" it.
- Never translate server `error.message` handling, emails, or seeded data.
- Never rename `thread`-named code identifiers to `chat` (or vice versa).
- Never touch any existing `TODO(i18n)` line — rich-text markers AND the named
  exceptions alike. Converting either is a human task. The reconciler only
  *adds* rich-text markers to new qualifying strings.
- Never rewrite an existing correct pt-br value for style alone unless it
  violates an explicit quality.md rule/example.
- Never add i18n dependencies — the module stays zero-dependency.
- Never edit `DOMAIN.md` or `quality.md`. `triage.md` and `quality-baseline`
  are the only domain files the reconciler writes. A needed rule change is a
  PR comment addressed to the owner, never a diff.
- Never edit en dictionary values or rename existing translation keys. The
  only en edit the reconciler makes is *adding* a key when moving a hardcoded
  string into the dictionary, and the added value is the hardcoded string
  verbatim, character-for-character. En copy is feature-team territory.
- Never remove or weaken a `satisfies` clause in `i18n/pt-br/` — a red
  `bun run check` is fixed by fixing keys, never by deleting the clause.
- Never add a `TODO(i18n)` marker to a string expressible as one `t()`
  template — extraction is the default; the marker is the exception.

## Examples

See [quality.md](./quality.md) for the good/bad pt-br examples that define the
subjective quality boundary.
