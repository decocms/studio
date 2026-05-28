# Feature catalog

This directory is the **executable contract** of every major product feature.

It exists because we ship faster than humans can verify. The catalog flips the
default: every feature ships its own self-verifying harness, and the human
review pass only happens after the harness is cohesive with the experience the
feature promises.

## Layout

```
features/
  <feature-name>/
    feature.md          # the story: what it does, why it matters, how to test it
    happy-path.test.ts  # the executable contract — runs end-to-end
    fixtures/           # optional — golden inputs/outputs the test pins to
```

## Invariants

- **One folder per feature.** Folder name = kebab-case feature id.
- **`feature.md` is required.** It carries the user-facing story, the canonical
  happy path, the file list of what implements it, and a prompt for AI agents
  who will extend it.
- **`happy-path.test.ts` is required.** It is the *single most valuable user
  journey* through the feature, expressed as a runnable Bun test. Edge cases
  belong in unit tests next to the implementation, not here.
- **The test must pass on `main`.** If it doesn't, that's the highest-priority
  bug in the repo until it does.
- **The test owns its environment.** No reliance on a running dev server or
  pre-seeded data. Spin up what you need (PGlite + `DevObjectStorage` is the
  default).

## Running

```bash
bun run features:list                 # list every catalogued feature
bun run features:test                 # run every feature's happy path
bun run features:test <name>          # run one feature
PW=1 bun run features:test <name>     # include the Playwright (browser) leg
```

CI runs the fast lane (no Playwright) on every PR. A nightly job runs `PW=1`.

## When to add a feature

Add a feature folder when **a coding agent extending this area** would need to
know what the user-facing contract is. Rule of thumb: if removing the code
would degrade the product story (not just a refactor), it's a feature.

Examples of catalogued features (current + planned):

- `page-editor/` — agent that builds landing pages section-by-section
- `brand-context-setup/` — onboarding flow that extracts brand from a domain (planned)
- `studio-pack-install/` — auto-install of the six default agents on `org.afterCreate` (planned)
- `automations/` — trigger-based webhooks running agents on a cron (planned)

## When to TOUCH a feature

Before writing any code that participates in a documented feature, follow the
loop described in `feature.md > Maintenance (THE LOOP)`. Short version:

1. Run the test against `main`.
2. Extend the test for your new behavior — RED.
3. Implement until GREEN.
4. Loop until the test and `feature.md` cohesively express the experience.
5. Only then ask a human to verify. If they reject, edit `feature.md` to
   capture the new expectation and loop.

## Why this is here, not in `tests/`

The `tests/` directory is for *engineering tests* (unit, resilience). The
`features/` catalog is for *product contracts*. Different audience, different
shape, different invariants — keeping them separate lets each evolve without
the other one pulling.

## Two layers of verification

For every catalogued feature:

1. **Deterministic** — `happy-path.test.ts` and the optional sibling
   `*.browser.spec.ts` (under `apps/mesh/e2e/tests/features/`). Pinned
   assertions, runs in CI, the contract.
2. **Exploratory** — an "Exploratory verification" section in `feature.md`
   describing the happy path as a [Webwright](https://github.com/microsoft/Webwright)
   task. Webwright is an MIT-licensed browser-agent framework from
   Microsoft Research that turns a plain-English task into a re-runnable
   Playwright script with screenshots + a numbered-CP self-verification
   log. Install as a Claude Code skill via `/plugin install webwright@webwright`,
   point it at a feature's task, and let an LLM-driven agent stress-test
   the happy path beyond what the deterministic spec covers (copy
   rendering, scroll behavior, race conditions a human would spot).
   Treat its output as evidence for a human reviewer, not a substitute
   for the deterministic contract.

The deterministic layer is the gate. The exploratory layer is the
canary — useful before a human pass, but never the only verification.
