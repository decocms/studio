# Native auto-updater — v1 implementation plan (macOS)

Goal: the desktop app updates itself. All hard logic lives in Rust; the web UI
reuses the existing `VersionCheckDialog` ("A new version is ready") card with
one native-gated edge: on desktop builds its button calls the Rust backend
instead of `window.location.reload()`.

Design summary (settled in design review + critique pass):

- The Rust backend **auto-checks, auto-downloads, and auto-installs** updates
  in the background. On macOS the install swaps the `.app` on disk while the
  running process is untouched — install-eagerly is safe because nothing
  re-reads the bundle path at runtime.
- The **existing drift mechanism is the notification channel**: the proxy's
  `rewrite_config_version` (which today pins `/api/config`'s `config.version`
  to the embedded bundle version so the browser-refresh nag never fires in the
  shell) gains one branch — once an update is *installed on disk*, it reports
  the staged version instead. The untouched dialog polls, sees drift twice,
  and shows the card. No new wire contract, no new poll, no new component.
- The card's button, under `useIsDesktopApp()`, POSTs a new local-api route
  that triggers a **graceful** restart via Tauri's `request_restart()` —
  documented to deliver `RunEvent::ExitRequested` reliably, so the repo's
  single shutdown pipeline (child sweeps, drain, instance-lock release) always
  runs. We do NOT add `tauri-plugin-process` or any webview updater
  capability: the trigger stays a Rust-side callback, keeping the webview IPC
  surface closed (capabilities/default.json gains nothing — worth a CI grep
  assertion that `updater:`/`process:` permissions never appear there).
- Update source of truth is a **rolling `native-updates` prerelease** on
  GitHub holding one `latest.json`, clobbered as the *last* step of
  `release-native.yaml`. `releases/latest/download/…` is unusable in this repo
  (seven workflows create stable releases across six tag schemes; Studio `v*`
  dominates "latest"), and serving the manifest from the app/web dist is
  broken by construction (the `.sig` exists only after the native build;
  self-hosted instances would freeze at their build version).
- `bundle.createUpdaterArtifacts` is **never committed** to
  `tauri.conf.json5` — it is enabled only via the release workflow's existing
  `--config` overlay (JSON Merge Patch per RFC 7396, so the nested `bundle`
  key augments rather than clobbers). Committed config with a pubkey +
  updater artifacts would fail every secretless (fork/PR) build. Conversely
  the release job asserts the signing secret is present and fails loudly.
- The updater never runs outside a real shipped build. Three independent
  gates, because `#[cfg(not(debug_assertions))]` alone is NOT enough —
  `native.yml`'s `tauri-build` job and `boot-smoke.ts` build the **release**
  profile at the committed `version: "0.1.0"`, which would see prod as
  "newer" and download ~80 MB over the CI bundle on every PR run:
  1. `#[cfg(not(debug_assertions))]` (mirror of the debug-only mcp-bridge
     registration) — covers dev loops;
  2. skip spawn when `selftest::is_enabled()` **or** the running version is
     the committed `0.1.0` placeholder — covers CI/smoke release builds;
  3. `DECOCMS_DISABLE_AUTO_UPDATE=1` honored at runtime and exported in
     `native.yml`'s boot-smoke step and `boot-smoke.ts` as belt-and-braces.
     The kill-switch logs `tracing::warn!` on every skipped cycle (silent
     freezes must be greppable in support diagnostics), and support docs must
     note a Finder-launched app doesn't inherit shell env — it needs
     `launchctl setenv` or a terminal launch.

Explicit non-goals for v1 (recorded so nobody "just adds" them):

- **Upstream-served update channel.** An upstream-controlled `latest.json` is
  unsigned (only the artifact is minisigned): a hostile self-hosted upstream
  could pair a high `version` with an old validly-signed artifact. v2 needs a
  signed manifest or a version-pin resolved against GitHub, Rust-side
  (`UpdaterBuilder::endpoints()` from `upstream::global().target()`). v1
  endpoint is the static GitHub URL. Note the same attack against the GitHub
  channel itself IS closed in v1 — see the version-pairing check in Phase 2a.
- **Run-aware restart gating.** The restart is an explicit user click on a
  card that only appears when an update is verifiably staged. A "N agent runs
  will be stopped" confirm can layer on later without structural change.
- **Linux/Windows.** The staged-state machine lives in one Rust module so the
  Windows difference (install force-exits the app — install must couple to
  restart consent there) becomes a branch, not a redesign.
- **Migrating pre-updater installs.** Brew users converge via the CI cask
  bump. Users who installed the DMG directly on a pre-updater version are
  stranded silently (no plugin, drift suppressed) — accepted deliberately;
  the cask/DMG release notes are the only channel to reach them.

## Merge order & shippability

`Phase 0 → Phase 1 → Phase 2 (+ Phase 4 in the same PR) → Phase 3`, each
independently shippable:

- Phase 0 must precede Phase 1's merge (the new signing-secret assertion
  would otherwise fail every release).
- Phase 1 before Phase 2 is harmless: manifest published, nothing consumes it.
- Phase 4 (`auto_updates true`) must ride the **Phase 2 PR**: merging the
  plugin + pubkey means the next release-tagging bump ships a self-updating
  binary, and from that moment `brew upgrade` would downgrade self-updated
  installs.
- Phase 3 before Phase 2 would be safe-but-dead (the card cannot appear in
  native without a staged version), but the order above avoids shipping a
  button that 404s.
- **Channel-promotion launch gate**: code merges freely, but do not run the
  first real promotion (and do not merge Phase 4) until the manual test
  (below) passes its go/no-go criteria — in particular the Keychain
  observation. Unsigned builds change CDHash every update, which breaks
  Keychain item ACLs (per `crates/upstream/src/tokens.rs`'s own docs); at
  ~daily promotion cadence a forced re-login per update is strictly worse
  than the status quo. The dormant `APPLE_*` Developer ID + notarization
  scaffolding in `release-native.yaml:133-158` activates on secrets alone —
  it should land before or with the first promotion.

---

## Phase 0 — signing key (existential; do first)

No minisign material exists anywhere in the repo; the `TAURI_SIGNING_*`
exports in both workflows are fork-safe dormant scaffolding. Whichever key
signs the first shipped updater release is permanent: the pubkey ships pinned
in every binary, and losing the private key strands the entire installed base.

1. `bunx @tauri-apps/cli@^2 signer generate -w ~/.tauri/decocms-updater.key`
   with a password. (Not `bunx tauri …` — that resolves the npm package
   literally named `tauri`, the v1 CLI. `-w` requires the path argument.)
2. Escrow private key + password in the org password manager (offline copy),
   NOT only in GitHub (secrets are write-only; a GitHub-only copy is a single
   point of loss).
3. Set `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in
   a GitHub **Environment** (e.g. `native-release`) with a deployment branch
   policy restricted to `main`. Precision on what that buys: Environments
   cannot restrict by workflow *file* — any workflow that runs on `main` and
   declares `environment: native-release` can read them (that requires a
   reviewed merge; optionally add required reviewers). This is still strictly
   narrower than repo-wide secrets, which every workflow — including the
   seven npm-publish workflows — can read. Phase 1 MUST add the matching
   `environment:` key to the `release` job or the secret resolves empty and
   every release fails.
4. The public key goes into `tauri.conf.json5` in Phase 2.
5. Runbooks (durable home: `release-native.yaml`'s header comment +
   `apps/native/README.md`, not this plan):
   - **Key loss** → cask is the break-glass channel: users recover via
     `brew upgrade --greedy --cask deco-studio`; keep the CI cask bump
     forever.
   - **Key leak** → there is no revocation channel; rotation = new key +
     cask-forced reinstall of the fleet. Audit escrow access; treat the
     GitHub Environment as the only CI holder.
   - **Bad release shipped** → the updater never downgrades; the fix is
     promoting a *newer* fixed release (use the `force_promote` dispatch
     input below if inside the throttle window). Broken-cannot-launch →
     cask reinstall.

## Phase 1 — release pipeline (`.github/workflows/release-native.yaml`)

All steps in the existing single `release` job, in this order:

1. **`environment: native-release`** on the job (see Phase 0.3).
2. **Lockstep assertion** (new step, after the existing `Read app version`
   step): fail the release loudly if `apps/api/package.json` and
   `apps/native/package.json` versions differ. `crates/local-api/build.rs`
   bakes `STUDIO_WEB_VERSION` from apps/api while the manifest/binary version
   comes from apps/native — equal only by the release-changes.ts lockstep; a
   single-sided bump would otherwise ship the permanent-nag state.
3. **Signing-secret assertion** (new step): a step with
   `if: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY == '' }}` that `exit 1`s with a
   pointer to Phase 0. The secret value never enters a shell; never inline
   `${{ secrets.* }}` into a `run:` body (multiline key = parse/injection
   hazard and only per-line masking).
4. **Build** — pin the CLI to an exact version (no `@latest`: the signer/
   bundler executing with the key in scope must not change under us; also
   verify once against the pinned version that env-var-supplied key
   *passwords* work — tauri#13485/plugins-workspace#2710 report password-
   via-env failures) and extend the existing overlay:

   ```yaml
   run: bunx @tauri-apps/cli@2.x.y build --config "{\"version\": \"$VERSION\", \"bundle\": {\"createUpdaterArtifacts\": true}}"
   ```

   Scope `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)` as step-level `env:` on this
   step only — not `$GITHUB_ENV` (the current dormant export makes the
   permanent key visible to every later step, including third-party CLI
   code, the cask python, and `gh`). The `APPLE_*` export step is unchanged.
5. **Collect updater artifacts** (extend the `assets` step): the bundler
   emits `target/release/bundle/macos/deco.app.tar.gz` (+ `.sig`). Copy to
   versioned names `deco-$VERSION-aarch64.app.tar.gz`(+`.sig`) and add both
   to the existing `gh release upload` for the immutable `native-v$VERSION`
   release (alongside ZIP + DMG).
6. **Assemble `latest.json` + decide promotion — via a tested script.** The
   throttle/manifest logic is real logic that must not first execute in a
   production release on a BSD-date macOS runner. Add
   `apps/native/scripts/ci/native-update-channel.mjs` (zero-dep Node, the
   `check-junit-allowlist.mjs` convention) exporting two pure functions with
   co-located unit tests, and a thin CLI entry the workflow calls:
   - `buildLatestJson({version, sigContents, notesUrl, pubDate})` —
     structured JSON construction (never shell/string interpolation; the
     `.sig` is base64 today but correctness-by-construction is free). Shape:

     ```json
     {
       "version": "$VERSION",
       "pub_date": "<RFC 3339>",
       "notes": "<native-v$VERSION release URL>",
       "platforms": {
         "darwin-aarch64": {
           "url": "https://github.com/decocms/studio/releases/download/native-v$VERSION/deco-$VERSION-aarch64.app.tar.gz",
           "signature": "<contents of the .sig file>"
         }
       }
     }
     ```

     Platform keys extend later (`darwin-x86_64`, `linux-x86_64`,
     `windows-x86_64`) without shape changes. Note: the updater validates
     the WHOLE file before reading `version` — when platform keys are added,
     one malformed entry bricks updates for all platforms.
   - `shouldPromote({currentManifest, candidateVersion, now, force})` with
     fail-open-to-promote semantics, in order:
     1. no current manifest / unparseable JSON → **promote** (first run:
        guard the `gh release download native-updates -p latest.json -O -`
        with `|| true` — it exits non-zero before the release exists);
     2. `currentManifest.version >= candidateVersion` (semver) → **skip**
        (prevents a repair-dispatch on an old ref from regressing the
        channel);
     3. `force` (a `force_promote: true` `workflow_dispatch` input) →
        **promote** — the escape hatch for urgent fixes inside the window
        and for healing a half-failed promotion;
     4. `pub_date` missing, unparseable, or **in the future** → **promote**
        (a clobbered far-future date must not freeze the channel forever;
        clock skew heals instead of wedging);
     5. `pub_date` age < 20 h → **skip** (the throttle: releases track the
        ~12×/day cloud cadence at ~80 MB/artifact; auto-download must cost
        ~one artifact/day). Else **promote**.
7. **Promote the channel — LAST**:
   - `gh release view native-updates || gh release create native-updates
     --prerelease --title "deco update channel" --notes "Rolling updater
     manifest. Do not install from here."` — `prerelease` keeps it out of
     GitHub's `releases/latest` forever (REST semantics: latest = most
     recent non-prerelease, non-draft).
   - `gh release upload native-updates latest.json --clobber` — idempotent,
     matching the workflow's re-run-only-heals repair semantics. Ordering
     guarantee: the manifest can never reference assets that don't exist yet.
   - Workflow-header caveats to record: GitHub's opt-in "immutable releases"
     repo setting would break the clobber; clobbered same-name assets can
     serve stale from the CDN briefly (tolerable at daily cadence).
8. **Failure alerting** (new step, concrete): `if: failure()` step following
   the fork-safe webhook pattern of `release-studio.yaml`'s docs-agent step
   (skip-when-unconfigured, warn on non-2xx) — or, with no webhook secret
   configured, create/update a pinned GitHub issue via `gh`. Rationale: a
   failed release today means unbounded, invisible staleness (drift is
   suppressed by design), and a throttle bug that always skips exits
   *successfully* — so also emit a `::notice::` with the promotion decision
   on every run to make silent-skip streaks greppable.

`native.yml` changes: export `DECOCMS_DISABLE_AUTO_UPDATE=1` in the
boot-smoke step (see gate 3 above). Nothing else — the committed config never
requests updater artifacts, so PR/fork builds stay green.

## Phase 2 — Rust

Interface-change note: this phase touches three contract-governed surfaces —
a `router.rs` route, an `AppState` field, and the `StartOptions`/`UpdateHooks`
pub API (`state.rs` carries the same "file an interface request" header as
`router.rs`). Treat them as ONE interface request and update the
module-ownership contract doc alongside. AppState (not the `lib.rs`
global-publish pattern used for `org_mount::set_credentials`) is the right
home because the consuming handlers already extract `State<AppState>`; a
separate field (not `EmbeddedOptions`) because embedded *debug* builds have
no updater either — the axes differ.

### 2a. `apps/native/src-tauri` — plugin, config, background task, restart trigger

- `Cargo.toml`s: add `tauri-plugin-updater = "2"` to the workspace-dep table
  in `apps/native/Cargo.toml` and `workspace = true` in
  `src-tauri/Cargo.toml` (repo pattern). The locked `tauri` 2.11.5 already
  has `request_restart` (added 2.4.0) and the post-update relaunch fix
  (tauri PR #12313).
- `tauri.conf.json5`: add (committed — safe: `createUpdaterArtifacts`
  defaults to false and the signing requirement triggers only when artifacts
  are produced):

  ```json5
  plugins: {
    updater: {
      pubkey: "<public key from Phase 0>",
      endpoints: [
        "https://github.com/decocms/studio/releases/download/native-updates/latest.json",
      ],
    },
  },
  ```

  Invariant to keep greppable (CI assertion is one line):
  `dangerousInsecureTransportProtocol` must never appear in this file or any
  `--config` overlay — it is the only thing between "pinned pubkey over TLS"
  and plaintext manifest fetch.
- `src/lib.rs`: register `tauri_plugin_updater::Builder::new().build()` under
  `#[cfg(not(debug_assertions))]`. The cfg-gate is load-bearing, not
  belt-and-suspenders: the plugin never auto-checks, but a debug binary with
  the plugin registered and config present *would* self-update if anything
  called `check()`.
- New module `src/updater.rs`:
  - A constructor `updater::init() -> (UpdateHooks, impl FnOnce(AppHandle))`
    so the watch channel exists **before** `StartOptions` is built at
    `setup.rs:274` and the spawn happens after the server starts (next to
    `spawn_auth_status_bridge`/`revalidate::spawn`, setup.rs:307-312) —
    ordering enforced by types, not convention.
  - **Pure decision logic lives OUTSIDE any cfg-gated module** (release-only
    cfg would compile its tests out of `cargo test --workspace`, which runs
    the dev profile — the test would appear to exist while never running).
    Only the spawn is gated.
  - Spawn gates (see design summary): `cfg(not(debug_assertions))` AND
    `!selftest::is_enabled()` AND running version ≠ `0.1.0` AND
    `DECOCMS_DISABLE_AUTO_UPDATE` unset (warn-log every skipped cycle when
    set).
  - Loop: `tokio::time::interval` of **30 minutes** (`MissedTickBehavior::Delay`,
    first tick consumed → the first check runs one interval after boot, no
    boot contention). Deliberately NOT the 5-min revalidate cadence: the
    manifest changes ≤ ~1.2×/day and card latency is dominated by the
    dialog's own 5-min × 2-confirmation poll anyway; 5-min checks would be
    ~288 no-op manifest fetches/day.
  - Per tick:
    1. `check()` with `UpdaterBuilder::timeout(…)` set. `check()` itself
       gates on remote > running (semver, built-in) — do not re-implement
       that comparison. Skip if the manifest version `==` the staged version
       (plain `!=` supersede semantics — a strict "newer than staged" would
       block channel rollforward after a botched release; semver ordering vs
       staged is not needed and hand-rolled comparison invites bugs).
    2. Skip if this version is memoized as failed and its backoff hasn't
       elapsed — **the failure memo is required, not polish**: without it, a
       persistently failing install (TCC block, disk full, bad signature)
       re-downloads ~80 MB every tick forever (~worst case tens of GB/day
       per affected client). One `(version, attempts, next_retry_at)` memo +
       exponential backoff capped at ~24 h; reset when a new version appears.
       Optional cheap pre-flight: skip download when free disk < ~3×
       artifact size.
    3. Set an `installing` flag (see 2b — the restart route 409s while it is
       up), then `download(…)` with a generous `tokio::time::timeout` (a
       stalled stream must not wedge the loop forever; downloads are not
       resumable — record that as a known v2 item), progress via the chunk
       callback at `tracing::debug!`.
    4. **Version-pairing check (v1 downgrade defense)**: before installing,
       verify the downloaded bundle's embedded version
       (`Info.plist` `CFBundleShortVersionString` from the tar.gz) equals the
       manifest's `version`. The minisign signature covers the artifact
       bytes but NOT the manifest's version field, and nine-plus workflows
       in this repo hold `contents: write` on the release surface — without
       this check, any of those tokens compromised = silent fleet-wide
       downgrade to an old validly-signed build. With it, a lying manifest
       can no longer pair a high version with an old artifact.
    5. `install()` under `spawn_blocking` (it is synchronous gunzip+untar+
       swap I/O; `setup.rs:246` documents the same rationale for TLS
       minting). Note the download buffers ~80-100 MB in RAM transiently —
       acceptable on desktop; recorded so a future memory report doesn't
       "fix" it blindly.
    6. On success: clear `installing`, `staged_tx.send(Some(version))`,
       clear the failure memo. On failure: clear `installing`, record the
       memo, `tracing::warn!` — except **signature verification failure gets
       its own distinct, greppable error line** (it means channel tampering
       or a botched key rotation, categorically different from offline/404,
       which stay silent by design).
- Restart trigger: `setup.rs` passes
  `Arc<dyn Fn() + Send + Sync>` = `move || app_handle.request_restart()` into
  `StartOptions`. `request_restart` delivers `ExitRequested` (→
  `shutdown::run_blocking` → full pipeline → respawn); the take-once in
  `shutdown.rs:18-31` tolerates duplicate delivery. Two recorded caveats:
  `restart_on_exit` is sticky, so a user quit racing a just-fired restart
  becomes a relaunch (narrow, harmless, worth a comment); and macOS has an
  open not-always-relaunching report (tauri#13923) — "process actually
  respawns" is an explicit manual-test pass criterion, not an assumption.

### 2b. `apps/native/crates/local-api` — state, rewrite branch, restart route

- `lib.rs` — extend `StartOptions` (standalone binary and tests leave it
  `None`; the compile-driven touchpoints are `boot_from_env`, the `lib.rs`
  tests, and `routes::intercept::test_state` + the per-module `test_state()`
  fns):

  ```rust
  /// Desktop-app self-update integration. `None` outside the packaged shell.
  pub update: Option<UpdateHooks>,

  pub struct UpdateHooks {
      /// Version an update task has installed on disk; `None` until staged.
      pub staged_version: tokio::sync::watch::Receiver<Option<String>>,
      /// True while `download_and_install` is running (install serialization).
      pub installing: Arc<AtomicBool>,
      /// Graceful app restart (Tauri `request_restart`).
      pub request_restart: Arc<dyn Fn() + Send + Sync>,
  }
  ```

  Store on `AppState` (`state.rs`) under the interface-request framing above.
- `routes/upstream.rs` — the staged-version branch. The wiring is slightly
  more than one line and the plan owns that: `rewrite_config_version` and its
  caller `proxy_public_config` have no `AppState` — thread the staged value
  (and hooks presence) down from `proxy` through both signatures. Extract the
  selection as a pure, unit-testable fn:

  ```rust
  /// Staged updates win; otherwise pin to the embedded bundle's version.
  fn reported_config_version(staged: Option<&str>, baked: &str) -> Option<String>
  ```

  and fix the interplay with the existing empty-`STUDIO_WEB_VERSION`
  early-return at upstream.rs:801: a staged `Some` must be reported even when
  the baked constant is empty (today's guard would silently suppress it).
  `patch_config_version` stays pure and untouched. Semantics: drift reaches
  the webview **iff** an update is installed on disk and ready.
  Update the module doc (784-799): the banner appears "in the browser — or
  in the shell when, and only when, a staged update makes its action real."
- `router.rs` — **the route MUST be inside a guard-carrying sub-router; the
  guard is not inherited at the top level.** A bare top-level `.route()`
  would get only `require_expected_host` — no Origin check on POST, no
  session cookie — i.e. an unauthenticated restart endpoint (a hostile
  previewed-sandbox page could then kill the user's runs with a `no-cors`
  POST). Concretely: mount under the existing `/_local` namespace as
  `/_local/update/restart` inside a guarded nest (pattern: the `/threads` /
  `app_api` sub-routers that carry `.layer(guard)`). `/_local` rather than a
  bare `/update` because bare paths are upstream-proxyable/SPA-fallback
  surface — the underscore namespaces are the repo's reserved-local
  convention (`is_reserved_api_path`, router.rs:728-746) — and because the
  Vite native dev proxy already forwards `/_local` (a bare `/update` would
  need a Vite change just to be testable in the dev loop).
- New `routes/update.rs` — `POST /_local/update/restart`:
  - `409 Conflict` when `state.update` is `None` (standalone), when no
    version is staged, **or while `installing` is true** — restarting during
    a superseding `download_and_install` would re-exec a half-swapped
    bundle; the updater task sets the flag before download and clears it
    after install completes (this is the serialization the frontend's "409
    race" narrative depends on).
  - Otherwise `202 Accepted`, then invoke `request_restart` from a spawned
    task after ~100 ms. The delay is best-effort flush, not a guarantee (the
    shutdown path drops connections immediately); losing the race costs a
    cosmetic network error on a dying page.

## Phase 3 — frontend (the only UI change)

`apps/web/src/components/version-check-dialog.tsx`:

- `const isDesktopApp = useIsDesktopApp();`
- Use the repo's mutation idiom (62 `useMutation` call sites; shape per
  `request-to-join-screen.tsx:24-38`) rather than hand-rolled state — and
  note plain `fetch` **resolves** on 409, so an `.ok` check is what makes the
  button recover, exactly the bug four reviewers flagged in the first draft:

  ```tsx
  const restartMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/_local/update/restart", { method: "POST" });
      if (!res.ok) throw new Error(`restart failed: ${res.status}`);
    },
  });
  ```

  Button:

  ```tsx
  <Button
    size="sm"
    disabled={restartMutation.isPending}
    onClick={() =>
      isDesktopApp
        ? restartMutation.mutate()
        : window.location.reload()
    }
  >
    {isDesktopApp
      ? t("announcements.version.restart")
      : t("announcements.version.refresh")}
    <RefreshCw01 size={14} />
  </Button>
  ```

  On 202 the app window closes and relaunches — no further UI state. On 409
  (staged update superseded mid-download) or network failure the mutation
  errors, `isPending` resets, the button re-enables; the next poll
  re-converges the card. A supersede also flickers the card for one ~5-min
  poll (drift count resets) — expected, harmless.
- Description swaps under the same gate:
  `isDesktopApp ? t("announcements.version.descriptionNative") : t("announcements.version.description")`.
- Title, eyebrow, aria-label, dismiss, and `currentSession` footer stay
  shared.
- **Delete the orphaned previous-incarnation keys** in the same PR (checklist
  item 5): `common.versionCheckDialog.available` / `.outdatedVersion` /
  `.refresh` in `en/common.ts:278-281` + `pt-br/common.ts:288-291` are
  referenced by no component (verify with grep at implementation time).

i18n — `apps/web/src/i18n/en/announcements.ts` gains:

```ts
"announcements.version.descriptionNative":
  "An update is installed and ready. Restart the app to start using it.",
"announcements.version.restart": "Restart to update",
```

`apps/web/src/i18n/pt-br/announcements.ts` mirrors (compile-enforced):

```ts
"announcements.version.descriptionNative":
  "Uma atualização foi instalada e está pronta. Reinicie o aplicativo para começar a usá-la.",
"announcements.version.restart": "Reiniciar para atualizar",
```

Note: the earlier idea of gating `VersionCheckDialog` out of native entirely
is **superseded** — the dialog is deliberately dual-purpose and stays mounted
unconditionally at `shell-layout.tsx:368`.

## Phase 4 — Homebrew cask (`Casks/deco-studio.rb`)

Add `auto_updates true`, **in the Phase 2 PR** (see merge order). Without it,
`brew upgrade` compares the tap version to its install receipt and reinstalls
(downgrades) over a self-updated app; with it, upgrades skip the cask by
default (`--greedy` still overwrites — fine, the app self-updates back). Keep
the CI cask auto-bump exactly as is (fresh installs need a recent baseline,
and the cask is the key-loss recovery path).

## Testing

Per the repo's two tiers and "test each behavior you touch":

- **Rust unit / in-process (`cargo test`)**:
  - `reported_config_version` pure fn: staged-Some wins; None → baked;
    staged-Some with empty baked still reports staged.
  - In-process proxy tests for the staged branch — the existing precedent in
    this exact test module (axum stub upstream on a `TcpListener` +
    `test_state`, cf. the set-cookie proxy test ~upstream.rs:1540): staged
    `None` → embedded version reported; staged `Some` → staged reported;
    flip mid-life (send after first request; second request reports staged —
    also covers watch freshness).
  - Router-level tests for `/_local/update/restart` with stubbed
    `UpdateHooks` (`request_restart` = flag-flip closure): 202 flips the
    flag; 409 when hooks absent; 409 when hooks present but nothing staged
    (distinct branch); 409 while `installing` is set. This also pins that
    the route landed *inside* the guard (an unauthenticated request must
    401/403, not 409).
  - Updater decision logic (memoized-failure/backoff/supersede) as pure fns
    in an **always-compiled** module (see 2a — cfg-gated tests silently
    never run).
- **Workflow script unit tests**: `native-update-channel.mjs`'s
  `shouldPromote` (all five branches, incl. future `pub_date` → promote,
  `>=` version → skip, force → promote) and `buildLatestJson` (structure,
  escaping) — co-located, `bun test`, per the `boot-smoke-paths.ts`
  precedent.
- **Native e2e** (`apps/native/e2e`, standalone binary, `update: None`):
  - Add `{ name: "update: restart", path: "/_local/update/restart" }` to
    `auth-matrix.e2e.test.ts`'s `CASES` — covers no-bearer/wrong-bearer 401
    and correct-bearer-not-401 (409) for free; no one-off auth test.
  - `GET /api/config` rewrite still pins the embedded version with no update
    handle: assert the reported version is NOT the stub upstream's sentinel
    (e.g. `9.9.9`) and is semver-shaped (the harness can't know the baked
    constant statically).
  - Daemon-parity/stub-seam allowlists are unaffected (they replay the
    daemon's own test files, which never touch these routes) — recorded so
    reviewers don't re-derive it. A `LOCAL_API_STAGED_VERSION` env seam for
    black-box staged-path coverage was considered and deliberately NOT
    added — the in-process tests above cover it without widening the
    standalone surface.
- **Web**: no new unit tests — the `isDesktopApp` fork is build-time-gated,
  response handling is `useMutation` (its `.ok` throw is the tested-idiom
  path), and the pure drift fns are already covered by
  `version-check-dialog.test.ts`; the pt-br mirror is compile-enforced.
  Checklist item 4 (grep all tiers for changed strings): browser copy is
  unchanged; native copy is behind new keys; `packages/e2e` asserts on
  neither (verified by grep).

## Manual test — executable runbook (gate for channel promotion)

The production endpoint is baked into the installed app, so "publish N to a
staging tag" alone tests nothing. Mechanism: a `workflow_dispatch` staging
mode of `release-native.yaml` (input `staging: true`) that (a) uploads to a
`native-updates-staging` rolling prerelease instead, and (b) builds with the
existing `--config` overlay extended to override
`plugins.updater.endpoints` to the staging URL. Same signing keypair. This
makes the test a repeatable runbook instead of archaeology — there is
otherwise NO end-to-end integration path for the updater at all.

On macOS 14+: install staging-N−1 via the real cask flow (quarantine-cleared),
publish staging-N, then verify — pass criteria, go/no-go for first real
promotion:

1. Background download+install succeeds (App Management TCC does not block
   the bundle swap; the `.app` on disk is N).
2. The card appears — worst case ~35-40 min with the 30-min check interval +
   two 5-min drift confirmations (do NOT expect "~10 minutes").
3. "Restart to update" → the process **actually respawns** into N (explicit
   criterion — open report tauri#13923 says macOS restart can quit without
   relaunching; the instance lock must have been released by the graceful
   pipeline), with no orphan rclone/harness processes.
4. Keychain: session survives, or the forced re-login is observed and the
   **promotion gate holds** until Developer ID + notarization land.
5. Note: a translocated app (direct-DMG download run from quarantine) runs
   from a read-only path — install fails into the (memoized, backed-off)
   warn path forever. Cask installs avoid translocation; record the
   direct-DMG limitation in the release notes.

## Follow-ups (recorded, out of v1)

- Developer ID + notarization — may be pulled INTO v1 by the promotion gate.
- Run-aware restart confirm ("N agent runs will be stopped").
- v2 upstream-controlled channel: signed manifest or version-pin design,
  Rust-side runtime endpoints.
- Linux/Windows platform keys + the Windows install-couples-to-exit branch.
- Persisted monotonic high-water mark (refuse to stage below the highest
  version ever staged) + freeze/replay telemetry (log when the installed
  version regresses below the last manifest version seen). The v1
  version-pairing check already closes the lying-manifest downgrade; these
  harden freeze detection.
- Resumable/streaming downloads (plugin buffers in RAM; no resume today).

## Critique Decisions

Eight-perspective review (correctness, security, architecture, testing,
performance, scope, duplication, documentation) applied to the first draft.

**Adopted (the significant ones):**
- CI/smoke release-profile exposure: added the selftest/0.1.0/env triple
  gate (correctness + architecture, independently).
- Route moved to `/_local/update/restart` inside an explicitly guarded nest —
  the draft's snippet would have shipped an unauthenticated restart endpoint
  (security + architecture, independently).
- Install/restart serialization (`installing` flag; 409 while installing) —
  the draft's own 409 narrative had no backend to make it true.
- Failure memo + backoff in the updater loop — without it a persistent
  install failure re-downloads ~80 MB per tick forever.
- Version-pairing check before install as v1 downgrade defense (manifest is
  unsigned and writable by nine-plus workflow tokens).
- `useMutation` + `.ok` handling — `fetch` resolves on 409; the draft's
  `.catch` left the button dead (flagged by four reviewers independently).
- Testing rewrite: pure `reported_config_version` fn (the draft's unit test
  targeted an *unchanged* function), decision logic out of cfg-gated code
  (tests would silently never run), in-process staged-path proxy tests,
  auth-matrix membership, tested promotion script (BSD `date` hazard).
- Throttle hardening: fail-open-to-promote semantics, semver gate,
  `force_promote` dispatch bypass, first-run guard.
- Developer ID reframed as a launch gate on channel promotion (not on code).
- Signer command fixed (`bunx tauri` resolves the v1 CLI), pinned build CLI,
  step-scoped signing env, `environment:` consistency between Phases 0/1.
- Executable staging-mode manual test with explicit relaunch (tauri#13923)
  and Keychain go/no-go criteria; realistic card-latency bound.
- 30-min check interval (manifest changes ≤ ~1.2×/day; card latency is
  dominated by the dialog poll), `download`/`install` split with
  `spawn_blocking`, check/download timeouts.
- Dead `common.versionCheckDialog.*` key deletion; `jq`-free structured
  manifest assembly; concrete `if: failure()` alerting; merge-order section;
  kill-switch logging + Finder-env caveat; runbooks (key loss/leak/bad
  release) with a durable home; App Translocation and DMG-direct-install
  acceptances; interface-request framing extended to `state.rs`.

**Rejected:**
- `LOCAL_API_STAGED_VERSION` standalone env seam for black-box staged-path
  e2e — in-process tests cover it; keeping the standalone surface minimal
  outweighs black-box purity here.
- Extracting a shared interval-loop helper — four sites × three configs is
  a config-heavy wrapper around ~4 lines; inline mirroring is the repo's
  accepted idiom.

**Adapted:**
- Persisted high-water mark: deferred to follow-ups — the version-pairing
  check closes the active downgrade attack; the mark only hardens freeze
  detection, which is already a recorded follow-up.
- "Newer than running AND staged" comparison: simplified to delegating
  running-vs-remote entirely to `check()` (built-in semver) and plain `!=`
  vs staged — strict ordering would block channel rollforward and duplicate
  the plugin's comparator.
- JS `relaunch()` rationale: the plugin has since migrated to
  `request_restart` internally; the decision (no plugin, no webview
  capability, Rust-side trigger) stands on IPC-surface grounds alone.
