---
name: daily-brief
description: Build the daily brief, one HTML page per day that the Studio home shows. Use when a daily-brief automation runs or someone asks for today's brief. Not for one-off reports or dashboards.
disable-model-invocation: true
---

# Daily brief

The daily brief is the organization's operating newspaper: one page per day
that says what changed, why, and where to act. Its reader will not open a
dashboard; they open the brief. Write for that person.

## Read the run's settings

The automation's message carries these lines; follow them:

- `Scope:` `org`, or `personal` with a user id.
- `Preset:` which reference file defines the sections and queries, or
  `custom`.
- `Connections:` the connections this brief may call. Call nothing else.
  `all` means every connection the org has.
- `Focus:` what the reader cares about, in their words. It narrows and
  orders the preset; it never replaces the preset's queries.
- `Write to:` the folder the HTML goes in.

## Preset

Look for `<preset>.md` first in `/app/org/home/skills/daily-brief/` (the
org's own presets win), then in this folder. Read it before calling any
tool. This folder ships:

- [storefront.md](storefront.md): sales, traffic, organic search, site
  health and code changes of one store.

`custom`, or a preset that exists in neither place: there are no validated
queries. Build at most 4 sections from the focus, one per question it asks,
using only the listed connections. Inspect each tool's schema before calling
it and say in the footer that the sections were inferred, not validated.

## Where to write

Write ONE HTML file, `<Write to>/<YYYY-MM-DD>.html`, dated today in the
org's time zone (America/Sao_Paulo when unknown: `TZ=America/Sao_Paulo date
+%F`). The home shows the newest file in that folder. Overwrite today's file
if it exists. Write nothing else in that folder.

When done, reply in the chat with 3 lines: overall status, the most
important thing today, and the path written.

## Personal scope

A personal brief is a cut of the preset for one person. Their focus says
which sites, services, repositories or topics are theirs; when
`/app/org/home/users/<userId>/daily-brief.md` exists, read it too. Filter
the preset's queries to that scope (for example by `namespace`,
`ServiceName` or `scriptName`). Org-wide context gets one line, for
comparison ("their cost rose 44% while the platform rose 14%"). "What to
look at today" only lists things this person can act on; when there is
none, say so. A calm day is news too.

## Rules

- Only numbers that came from a tool in this run. Do not invent a metric or
  estimate what you did not measure.
- A source that failed shows as `FAILED: <source> — <error>` in its section
  and in the footer. A failure never becomes zero, "no errors" or "stable".
- Every headline metric comes with comparisons: d-1 (yesterday), w-1 (same
  weekday last week) and, when the source keeps a year, y-1. Show the value
  and the Δ%. With no baseline, say "no baseline".
- A change only makes "what to look at today" when it is large enough for
  someone to act on. Say why it matters and what to do, not only the number.
- About 20 tool calls at most. Prefer one aggregated query to a loop per
  item.

## HTML structure

1. **Header**: org name, date, window covered, overall status
   (green/yellow/red) with one sentence that justifies the color.
2. **Executive summary**: 3 to 5 sentences. What happened yesterday against
   normal. Someone who reads only this knows whether the day was good.
3. **What to look at today**: at most 3 items, each with the number, the
   evidence (where it came from), the impact and a suggested action with a
   link.
4. **Preset sections**, each with KPI tiles (value + Δ d-1 + Δ w-1 + Δ y-1
   when available) and at most one short table.
5. **Footer**: sources queried, sources that failed, collection time.

## Style

Use `template-<preset>.html` from this folder when it exists, otherwise
`template-storefront.html`. Read it before writing the HTML.

- Copy the template's whole `<style>` unchanged. It carries the light and
  dark themes and the provider icons.
- Build the `<body>` from the template's classes. The template shows one
  example of each block (header, headline, what to look at, tiles, table,
  bars, failure, footer); repeat the blocks with your data and delete the
  examples and comments. Do not invent classes.
- Icons: `<span class="ic ic-<provider>"></span>` next to section titles, in
  link chips and in the footer. Providers with an icon: `ga4`, `gsc`,
  `vtex`, `github`, `health`, `ab`, `lake`, `clickhouse`, `cloudflare`,
  `grafana`, `prometheus`, `deco`. A source without one gets none.
- Overall status: `good` (green, better than normal), `warn` (yellow,
  attention), `bad` (red, act today). On a Δ, `good`/`bad` say whether the
  change is good for the business, not its direction: cost and errors going
  up are `bad`; revenue going up is `good`. Below 2% is `flat`.
- No JS and no external resources.
- Write in the language the focus is written in; Brazilian Portuguese when
  there is no focus. Format numbers and currency for that language.
