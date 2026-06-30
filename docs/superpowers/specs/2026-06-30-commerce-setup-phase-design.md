# Commerce Setup Phase Design

> Follow-up to `2026-06-30-commerce-onboarding-design.md` (PR #4190), which built the auth + org-resolution foundation and explicitly deferred *"the final commerce-specific UI and the exact MCPs installed during commerce setup"* to a subsequent spec. **This is that spec.**

## Goal

Define what `CommerceSetup` does once `/commerce-onboarding` has resolved a selected organization: take the diagnostic the visitor saw on the public landing page, attach it to their org, enrich it with their connected data sources, and render the **full report inside Studio** (not on the marketing site). The public landing renders only the free/public teaser; the full report lives in the Studio/MCP app.

## Context (what already exists)

- **Foundation — PR #4190:** the `/commerce-onboarding` route authenticates the user (`/login?next=/commerce-onboarding`), resolves the org (auto-select / picker / local recovery via `ensureUserOrganization`), and hands a selected org to `CommerceSetup({ org })`. `CommerceSetup` is currently a placeholder.
- **Credential vault — PR #4190 + the runtime `createStudioVaultClient`:** Studio leases downstream connection tokens/config to workers via `POST /api/:org/vault/connections/:connectionId/{access-token,configuration}`, gated by `credential:*:read` grants on a workload token.
- **Engine (`commerce-discovery`):**
  - Public read: `GET /api/v2/public/diagnostics/:domain` (anonymous) — the teaser the landing already renders.
  - Upgrade: `POST /api/v2/internal/diagnostics/:domain/upgrade { org_id }` (master key) — links the diagnostic to the org, mints a per-(org,url) **`dgn_` client token**, sets `scope=private`, and re-runs (cached public subs kept; private subs added).
  - Org-scoped read: the **token-MCP** `get_my_diagnostic` / `list_my_diagnostics`, pinned to one `(org, url)` by the `dgn_` token.
  - Credentials pull (#72, merged): the engine resolves private-diagnostic creds (VTEX today; GA4/GSC planned) from **Studio Vault** via the runtime config binding + `org_provider_connection`.

## The domain handoff (no cookie)

The diagnostic domain rides the **existing `next` URL convention**, not a cookie:

```
landing public report  ──CTA──►  <studio>/commerce-onboarding?domain=<domain>
   (signed out)        ──────►  /login?next=/commerce-onboarding?domain=<domain>  ──►  back to the route
```

`/commerce-onboarding` already types `domain?: string | null`; this spec adds it to the route's `useSearch` and threads it into `CommerceSetup({ org, domain })`. If `domain` is absent (user arrived without a prior scan), `CommerceSetup` offers a URL-entry step that triggers a fresh public scan first.

## Commerce Setup phase — data flow

Once `CommerceSetup` has `{ org, domain }`:

1. **Claim the diagnostic for the org.** Call the engine `POST /api/v2/internal/diagnostics/:domain/upgrade { org_id }` (server-side, master key held by Studio — never the browser). The engine links the org, mints the `dgn_` token, flips `scope=private`, and re-runs. Idempotent: re-visiting `/commerce-onboarding` for the same `(org, domain)` is safe.
2. **Persist the `dgn_` token** against the org's commerce-discovery connection so the Studio app can read the report later (this is the report's home — no Studio reports table).
3. **Install / ensure the commerce data-source MCPs.** Ensure the org has the connections the private report needs (VTEX, GA4, GSC, …) and that the commerce-discovery engine is granted `credential:configuration:read` on them, so the engine's `ExternalCredentialProvider` (#72) can pull their config from the vault. Selecting these connections on the engine's runtime config is what populates `org_provider_connection` engine-side.
4. **Render the full report in Studio.** Read the diagnostic via the token-MCP `get_my_diagnostic` and render the deck inside the Studio app. As private subs resolve (creds present), the report gains private sections on top of the public ones.
5. **Paywall (blur).** The first sections render; the rest are blurred with a "See full report" CTA → checkout (see Billing). Gating is enforced Studio-side over the engine's per-section visibility/entitlement.

## What this spec requires from the engine (cross-repo)

- GA4 + GSC credential providers (mirror the merged VTEX #72) — tracked in `commerce-discovery` `docs/superpowers/plans/2026-06-30-ga4-gsc-studio-vault-provider.md`. Needs the GA4/GSC binding ids + MCP config field names.
- Private-sub **verdict mappers** so private subs emit findings (not just raw data) into the summary/sections.
- A **per-section entitlement/tier** concept on the engine `Section` for the paywall (today only all-or-nothing `public_blocked` + public/private visibility).

## Billing (paywall)

Out of scope for the first cut, but the gate attaches here: a `report_entitlements` record per `(org, url)` and a checkout (reuse the AI-gateway credit rail or a dedicated Stripe surface — decision pending). Until billing exists, `CommerceSetup` can show the full report ungated behind the connect step.

## Route isolation & idempotency

Inherits #4190's rules: `/commerce-onboarding` never redirects to `/onboarding`; the setup phase is **repeatable** — a returning user can revisit `/commerce-onboarding?domain=` (or pick a domain) and resume. The `/upgrade` call and connection-ensure are idempotent.

## Out of scope

- The exact visual design of the full-report view in Studio.
- The final billing processor decision (Stripe vs gateway).
- The GA4/GSC engine providers and verdict mappers (tracked in `commerce-discovery`).

## Testing

- Unit: `domain` search-param threading; idempotent `/upgrade` call wrapper; entitlement gate decision.
- E2E: public teaser CTA → `/login?next=/commerce-onboarding?domain=` → authenticated `/commerce-onboarding` resolves org → `CommerceSetup` claims the diagnostic and renders the (gated) full report; revisiting is idempotent.
