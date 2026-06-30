# Commerce Onboarding Foundation Design

## Goal

Create a dedicated `/commerce-onboarding` flow for commerce customers without changing the existing general `/onboarding` flow. The two routes may share lower-level components and org membership helpers, but they must never redirect users into each other.

This spec covers the authentication, organization selection, organization recovery, and route isolation foundation. The final commerce-specific UI and the exact MCPs installed during commerce setup are intentionally separate follow-up inputs.

## Current Behavior

Studio already has a general `/onboarding` route. It is used for users with no active organizations and supports corporate-domain discovery, auto-join, request-to-join, and organization creation.

The `/login` route does not create organizations directly. It authenticates the user and redirects using the existing `next` search parameter, for example `/login?next=/commerce-onboarding`.

Organization creation currently happens in Better Auth hooks or explicit organization creation endpoints. New organizations run the existing org bootstrap path through `seedOrgDb`, which creates default MCP connections and enqueues the Studio Pack install.

## Route Isolation

`/onboarding` remains the general Studio onboarding flow.

`/commerce-onboarding` becomes a separate commerce setup flow.

The isolation rule is strict:

- `/commerce-onboarding` must not redirect to `/onboarding`.
- `/onboarding` must not redirect to `/commerce-onboarding`.
- Shared components must not own route-level redirects between these flows.
- Route-specific outcomes stay in the route that invoked the shared component.

## Authentication Flow

`/commerce-onboarding` requires an authenticated user. If the user is signed out, the route redirects to:

```text
/login?next=/commerce-onboarding
```

This uses the app's existing `next` convention. `returnUrl` is not currently read by the login route.

After login, the user returns to `/commerce-onboarding`.

## Signup Organization Policy

Signup should ensure the user has an organization whenever it can do so safely.

For verified corporate email users, where:

- `emailVerified === true`
- the email has a domain, such as `deco.cx`
- the domain is not in `GENERIC_EMAIL_DOMAINS`

the signup hook should use domain-aware behavior:

1. If there is one verified auto-join org for the domain, add the user to that org.
2. If there are multiple matching verified orgs, or only request-mode matches, do not create a duplicate org. Leave the user to choose or request access inside the route they are visiting.
3. If there is no verified org claim for the domain, create a new domain-derived org.
4. The domain-derived slug preserves the full domain for uniqueness. For example, `deco.cx` becomes `deco-cx`.
5. The new org claims the email domain immediately with `joinMode: "auto"`, `verificationStatus: "verified"`, and `verificationMethod: "email"`.

For generic email users, keep the existing user-derived default organization behavior.

If organization creation is disabled by deployment configuration, the route-level recovery behavior still handles zero-org users locally.

## Commerce Route Org Resolution

After authentication, `/commerce-onboarding` loads the user's active organizations.

If there is exactly one organization, the route selects it automatically and proceeds to commerce setup.

If there are multiple organizations, the route renders a picker so the user chooses the target organization.

If there are zero organizations, the route performs local recovery and does not send the user to `/onboarding`:

1. For a verified corporate email with no conflicting verified domain claims, create the domain-derived org and claim the domain.
2. For a generic email, create the existing style of default user-derived org.
3. For ambiguous corporate-domain situations, render the same shared org choice/request UI used by the general onboarding route, but keep the user in `/commerce-onboarding`.
4. If recovery cannot resolve the user into an org, render a commerce-specific error/support state.

Zero-org handling is defensive recovery for legacy users, deleted or archived orgs, disabled auto-creation, ambiguous domain membership, or partial signup failures. It is not the expected happy path for new users.

## Shared Organization Choice UI

Extract the domain membership choice UI from `/onboarding` into a reusable component. The component should be route-neutral and should not know whether it is used by `/onboarding` or `/commerce-onboarding`.

The shared component should support:

- listing candidate organizations
- auto-join actions for `joinMode: "auto"`
- request-to-join actions for `joinMode: "request"`
- already-requested state
- route-owned selection callbacks
- route-owned success handling
- route-owned fallback actions

The shared component should not:

- redirect to `/onboarding`
- redirect to `/commerce-onboarding`
- assume a specific customer segment
- create route-level navigation side effects beyond callbacks supplied by the caller

## Commerce Setup Boundary

Once `/commerce-onboarding` has a selected organization, it enters a commerce setup phase.

This foundation should define the selected-org handoff but not hard-code the final commerce setup UI or MCP list. The setup phase should be structured so a subsequent commerce setup spec can add concrete MCP definitions without changing the auth or org-resolution flow.

The route should be repeatable. A user who already belongs to an org can visit `/commerce-onboarding` directly, choose an org if needed, and run or resume the commerce setup flow for that org.

## Data Flow

1. User opens `/commerce-onboarding`.
2. If signed out, route redirects to `/login?next=/commerce-onboarding`.
3. Login authenticates and returns the user to `/commerce-onboarding`.
4. Route loads active organizations.
5. Route resolves the selected organization:
   - one org: auto-select
   - multiple orgs: user picks
   - zero orgs: recover locally
6. Route hands the selected org to the commerce setup phase.
7. Commerce setup installs or configures the commerce-specific MCPs once those requirements are provided.

## Error Handling

Org creation collisions should retry with bounded entropy while preserving the domain-derived base slug when possible.

Domain ambiguity should not create duplicate orgs. It should render a choice/request UI owned by the current route.

Failures in default org seeding or Studio Pack installation should not trap the user in auth. They should be logged and surfaced in the setup phase if they block commerce setup.

If the org list request fails, `/commerce-onboarding` should show a local retryable loading/error state instead of redirecting to the general onboarding flow.

## Testing Strategy

Unit tests should cover pure helpers:

- domain-to-slug conversion, such as `deco.cx` to `deco-cx`
- corporate vs generic domain classification
- org-resolution decision logic for zero, one, multiple, and ambiguous org states

E2E coverage should cover route behavior over HTTP/browser boundaries:

- signed-out `/commerce-onboarding` redirects through `/login?next=/commerce-onboarding`
- new verified corporate signup with no existing domain org creates a domain org and claim
- future verified corporate signup auto-joins the unambiguous domain org
- ambiguous domain users stay within `/commerce-onboarding` and see the shared choice/request UI
- `/commerce-onboarding` never routes to `/onboarding`
- `/onboarding` never routes to `/commerce-onboarding`

## Out Of Scope

This spec does not define the final visual design of `/commerce-onboarding`.

This spec does not define the exact commerce MCPs to create or install.

This spec does not remove or replace the existing `/onboarding` route.
