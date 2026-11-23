---
name: talk-to-your-data
description: Answer a business question with real numbers from the organization's connected data sources (web analytics, commerce orders, ads and attribution, data warehouse, search console). Use when the user asks for a number, a metric or "how did X perform" over a period, such as sales, orders, revenue, traffic, conversion, installs or campaign results, including comparisons and trends. Uploaded spreadsheets and PDFs belong to the file skills, and code changes are outside this skill.
---

# talk-to-your-data — answer from the connected sources

Every number in the answer comes from a tool result of this run. Run the
queries yourself, in this chat, through the `decocms` CLI session the sandbox
already has: search once, query, check, answer. A one-number question takes
three or four calls. `<slug>` is the organization's slug (`decocms orgs`).

## 1. Find the source: one search, with schemas

```bash
decocms tools call CONNECTION_TOOLS_SEARCH --org <slug> \
  -d '{"query":"analytics report sessions","withSchema":true,"limit":5}'
```

- Query with the source and the metric as keywords ("orders list",
  "warehouse query", "installs aggregated", "search console"). Words in the
  tool name weigh most, then the connection title, then the description.
- Each hit carries `name`, `inputSchema` and `connections: [{id, title}]`,
  which is all the call needs. Listing or describing tools adds nothing.
- The same tool on several connections means several stores, properties or
  accounts: choose by `title`, and ask when the question does not settle it.
- Nothing after a second query with other words: the source is not connected.
  Name the missing source ("no ads platform is connected") and stop there.

Done when you hold a tool name, a connection id and its input schema.

## 2. Query with explicit period, time zone and scope

```bash
cat > /tmp/q.json <<'EOF'
{"connectionId":"<id>","toolName":"<tool>","arguments":{"startDate":"2026-03-14","endDate":"2026-03-14"}}
EOF
decocms tools call CONNECTION_TOOL_CALL --org <slug> -d @/tmp/q.json > /tmp/r.json
python3 -c 'import json;r=json.load(open("/tmp/r.json"));print(r.get("isError"),r["content"][0]["text"][:3000])'
```

- The keys are exactly `connectionId`, `toolName` and `arguments`. Any other
  key (`input`, `params`) is dropped without an error, and the tool then
  reports its required fields as missing.
- A failed tool call still exits 0: read `isError`. The result is
  `content[0].text`, usually a JSON string to parse again. Keep it in a file
  and extract what you need; `head -c` cuts JSON in the middle.
- **Period**: absolute start and end dates. Resolve "yesterday" or a named
  sale day to dates first (`date` prints today), and read in the schema
  whether the end date is inclusive.
- **Time zone**: a day is the business's local day. Find the zone the source
  reports in (property or account setting, or UTC timestamps), convert when
  it differs, and carry the zone you used into the answer.
- **Scope**: the property, account, store, app or sales channel in question.
  Get its id from the source's own list tool (accounts, properties, apps).
- An authentication or access-denied error ends that source: report the
  connection and the error so the user can fix access. A retry changes nothing.

## 3. Check before reporting

- **Coverage**: the first and last dates in the result match the period asked
  (add a date dimension to see them). An absent day is "no data", not zero.
- **Complete days**: today is partial, and many sources keep processing the
  last 24 to 48 hours. End on the last closed day or flag the partial one.
- **Totals**: breakdown rows add up to the total. When they do not (sampling,
  thresholds, pagination), query the total on its own. A result with exactly
  `limit` rows is truncated: page until the end.
- **Definition**: created or paid orders, with or without cancelled; gross or
  net revenue; users or sessions. Use the one the user means and name it.

## 4. Answer: the number first

> **1,284 installs** on 14 March 2026 (iOS 702, Android 582).
> Source: attribution tool, aggregated report. Period: 14 March, full day.
> Time zone: UTC, the source's reporting zone. Caveat: none.

Always number, period, source, time zone, then any caveat: partial day,
sampled, definition used, a part no source could answer.

For a trend or a breakdown with more than a handful of points, also write one
self-contained HTML chart (data and scripts inline, no network requests) to
`/app/org/output/<name>.html` and name it in the answer.

## Comparisons and trends

- Take both sides from the same source, with the same metric, filters and
  time zone, in one call when the tool accepts two date ranges.
- Year over year on a short period: align weekdays (364 days back) or align a
  calendar event to the same event, and say which.
- A partial period compares against the same number of days or hours elapsed.
- Report both absolute values and the change. Compute a rate from the totals
  (orders / sessions over the period), never as the mean of daily rates.
- Analytics and the order system disagree by design (consent, blockers). Use
  the order system for orders and money, analytics for traffic and funnel
  steps, and say so when a ratio mixes them.

## Rules

- **Real data only.** A gap stays a gap: say what is missing and which source
  would fill it. Never estimate, interpolate or answer from memory. A
  projection the user asks for is labelled as one, next to its real inputs.
- **Query here.** Do not open a thread on another agent to get the number,
  and do not wait with `sleep`: both are slower and lose detail.
- **Read-only.** Call tools that read. One that writes, sends or deletes
  needs the user's explicit request for that action.
- **Warehouse cost.** Read one table's schema first, then filter on the date
  partition, select only the columns needed and aggregate in SQL. Explore
  with a one-day range and a `LIMIT`, never `SELECT *` on an event table.

## Source notes

- **Web analytics reports**: dates follow the property's time zone. Item-level
  metrics are rejected next to session- or event-level dimensions; split into
  two reports instead of swapping in a different metric.
- **Analytics export in a warehouse**: event timestamps are UTC, while the
  daily tables are cut by the property's time zone. Restrict by table date
  first, then convert the timestamp before grouping by local day or hour.
- **Commerce orders**: creation dates are typically stored and filtered in
  UTC, so a local day at UTC-3 runs from 03:00Z to 02:59Z of the next day.
  Check one order's timestamp before trusting a daily cut. Filter by status
  and by sales channel when the question separates site from app.
- **App attribution**: iOS and Android are separate app ids. Query each and
  add them up.
