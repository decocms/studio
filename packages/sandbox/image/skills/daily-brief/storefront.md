# Storefront brief

For the store's team: how the store sold yesterday, where traffic came from,
how organic search is doing, whether the site broke and what changed in the
code. The reader runs the e-commerce; they want to know whether the day was
good and what to do today.

"Yesterday" is the previous full day in the store's time zone. Every
comparison window is a full day: d-1 = the day before yesterday, w-1 = same
weekday last week, y-1 = same weekday last year (364 days earlier, so Monday
compares with Monday).

## Sources

Find the org's connections by app, not by title: GA4
(`google-analytics`), Search Console (`google-search-console`), the
e-commerce platform (`vtex`, or another), the store's repository
(`mcp-github`), System Health MCP. Use `CUSTOMER_LAKE_QUERY` when it holds
the store's orders.

The ids you cannot guess (GA4 property, Search Console site, repository,
service name in System Health) live in
`/app/org/home/skills/daily-brief/sources.md`. Read it first. When the file
is missing or an id is wrong, discover it (`get-account-summaries`,
`list_sites`, ...) and write the corrected `sources.md` at the end of the
run. A source with no connection goes in the footer as "not connected", not
as a failure.

## Section 1. Sales

Main source: the e-commerce platform. On VTEX:
`VTEX_GET_SALES_PERFORMANCE_SUMMARY` (revenue, orders, average ticket, items
per order, comparison date included), `VTEX_GET_SALES_PERFORMANCE_TREND` for
the series and `VTEX_GET_HOME_TOP_PRODUCTS` for the best sellers. Read each
tool's schema to pass the reference and comparison dates; run once for d-1
and once for w-1.

When `CUSTOMER_LAKE_QUERY` has orders, it replaces VTEX for the numbers and
gives y-1 and the split by channel, coupon, UTM and region in one query.

Tiles: revenue, orders, average ticket, conversion rate (GA4 orders /
sessions). Table: yesterday's top 10 products with Δ vs w-1. Call out a
product that dropped hard or left the top (stock-out is the first
hypothesis: check `VTEX_GET_INVENTORY` before claiming it).

## Section 2. Traffic and funnel

GA4 `run-report` on the property from `sources.md`. One call with 4
`dateRanges` (yesterday, d-1, w-1, y-1) and the metrics `sessions`,
`totalUsers`, `ecommercePurchases`, `purchaseRevenue`, `addToCarts`,
`checkouts`. Another with the dimension `sessionDefaultChannelGroup` for
yesterday and w-1. Another with `deviceCategory` when conversion moved.

Show the funnel (sessions → add to cart → checkout → purchase) with Δ w-1 at
each step: the step that got worse is where to act. A channel that moved
more than 20% vs w-1 goes in "what to look at today".

GA4 revenue and the platform's never match; the platform's is the truth and
GA4 is quoted only for conversion.

## Section 3. Organic search

Search Console `query_search_analytics` on the site from `sources.md`,
always with `dimensions` (the tool fails without them). Data arrives 2 to 3
days late: use the latest day available and say which one it is.

- Daily totals (`dimensions: ["date"]`) for the last 14 days: clicks,
  impressions, CTR, average position. Compare the latest day with the same
  weekday a week before.
- Top 10 queries and top 10 pages by clicks for the last 7 days vs the 7
  before; call out the ones that lost the most clicks.

## Section 4. Site health

System Health MCP for the store's service: `APPLICATION_ERRORS` and
`LIST_ERRORS_TIMESERIES` (errors in the last 24h vs the 24h before),
`LIST_LATENCY` (p50/p95), `INFRA_ANOMALIES` and `CERT_STATUS`. An error spike
that lines up with a conversion drop goes in "what to look at today".

## Section 5. Code changes

The store's GitHub repository: `list_commits` and `search_pull_requests`
(merged in the last 24h). List what shipped, one line each, with a link.
When a deploy lines up with an error spike or a conversion drop, say so
explicitly, with the times.

## Section 6. Experiments (optional)

When the org has an A/B report connection, run `get_experiment` (`ab_report`
with no arguments comes back empty) and show each active experiment's state:
variant, traffic, conversion and whether it is significant yet. With no
connection, leave the section out.

## Action links

Use the sources' own links: the GA4 report, the property's Search Console,
the platform's admin, the pull request on GitHub.
