# Web work

## React and layout

React Compiler handles memoization. Use the existing external-store patterns
for subscriptions, including `useSyncExternalStore`; `useEffect`, `useMemo`,
`useCallback`, and `memo` are banned here.

Use design-system tokens such as `text-success`, `bg-special`, and
`text-warning`. Keep shared UI components in `packages/ui` independent of
app domain state.

Before changing route composition, headers, tabs, scrolling, or chat placement,
read [the component architecture guide](docs/component-architecture.md).
It owns `Layout`, `ChatLayout`, `Panel`, and `Page` composition and provider
boundaries.

Before adding realtime subscriptions, read
[the API delivery instructions](../api/AGENTS.md#realtime-delivery).
Before reading or adding organization flags, read
[the shared flag instructions](../../packages/shared/AGENTS.md#organization-flags).

## User-facing strings

Use `const t = useT()` from `@/i18n/use-t.ts` for JSX text, toasts,
placeholders, tooltips, empty states, and accessibility labels. Use `{name}`
placeholders for interpolation.

English dictionaries under `src/i18n/en/` own translation keys. Add each key
to the matching `pt-br` dictionary, which must satisfy the English key type.
For a new domain, register both dictionaries in their respective `index.ts`.
Keys may use `thread`; displayed values use "chat".

Language names stay in their own language. Server-originated messages,
transactional emails, and seeded or user-provided data stay outside UI
translation; do not pass locale to the server for these. Keep `packages/ui`
i18n-free and pass translated overrides from the app.

For strings interleaved with JSX that cannot be expressed as one template,
leave the text with `// TODO(i18n): rich text` for a manual pass.

## Experiments

Use `useExperiment("<flag-key>")` for PostHog assignments. Organization flags
are deterministic product gates and cannot substitute for experiment cohorts.

Read the variant only where the experiment applies: reading records exposure.
Treat `undefined` as control while flags load and on deployments without
`POSTHOG_KEY`. Check loading behavior for above-the-fold variants; client-side
assignment can briefly show control first.

Randomize in-product experiments by the PostHog `organization` group, so
teammates see the same variant. `PostHogGroupSync` binds the session's org.
User-level randomization is for pre-signup flows without an organization.

Declare the primary success event with `track` or `captureOrgEvent` before
writing variant code. Compare results with the permanent
`experiment-pipeline-check` A/A experiment's noise floor.
