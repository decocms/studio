# Linux support for the Studio desktop app — implementation plan

Status: proposed. Scope: port `apps/native` (Tauri v2 desktop shell) to Linux and
ship it as an x86_64 AppImage wired into the existing self-update channel.

Companion docs: `native-updater-plan.md` (the updater design this extends),
`org-fs-plan.md` (the org filesystem this ports).

---

## 1. Overview & guiding decisions

The app is macOS-only today in five load-bearing places: TLS trust for the local
control origin is installed via the macOS `security` CLI and is **fatal at boot**
(`src-tauri/src/local_tls.rs:224-269`, `setup.rs:239-259`); the org filesystem is
an `rclone nfsmount` + BSD `mount`-table stack (`crates/local-api/src/sandbox/org_mount.rs`);
the rclone fetch script knows only darwin triples (`scripts/fetch-rclone.sh:35-41`);
bundle targets are `["app","dmg"]` (`src-tauri/tauri.conf.json5:122`); and every CI
and release job runs on `macos-latest`.

Everything else is already portable by construction — process management is POSIX
with no `libc`/FFI (the workspace sets `unsafe_code = "deny"`), token storage is
trait-seamed with a working Linux backend already in `Cargo.lock`, OAuth uses the
system browser over a loopback redirect, and there are no custom URI schemes.

Three phases: **compile & boot**, **org-FS mount**, **release/updater**. On Linux the
webview is WebKitGTK, so trust becomes an in-app per-host certificate exception
registered before first navigation — no keychain, no root, no prompt — behind a
default-off flag for the first release.

| Decision | Choice | Why |
|---|---|---|
| v1 distribution | AppImage + the existing tauri updater channel | No packaging infra needed; AUR/apt/COPR deferred; Flatpak/Snap out of scope |
| deb/rpm | Deferred; if ever produced the updater must stay suppressed | The plugin rewrites `$APPIMAGE` in place; the day-one `APPIMAGE` env gate suppresses it everywhere else |
| Manifest invariant | `latest.json` promoted only when **every** platform's assets are on the immutable release | A partial manifest bricks updates for all platforms (`native-update-channel.mjs:111`) |
| **Hold-back scope** | **Only the channel promotion.** Release creation, asset upload, and the Homebrew cask bump publish per-leg | A Linux build failure must never freeze macOS distribution or the cask — which the release workflow header designates as break-glass for updater key loss |
| Immutable-release assets | **Write-once**: never `--clobber` a `native-v*` tag; clobber only the rolling `native-updates` manifest | A repair dispatch rebuilds non-reproducibly; re-uploading bytes under an unchanged signature/sha breaks both self-update and `brew install` |
| Linux TLS trust | In-app WebKitGTK per-host exception (`webkit_web_context_allow_tls_certificate_for_host`) on the **leaf** cert; behind `DECOCMS_LINUX_SECURE_ORIGIN` (default-off for the first release) | AppImage has no postinst, so system anchors are hostile UX; a fatal boot path with no cask to reinstall from needs a runtime escape |
| Child CA trust | `SSL_CERT_FILE` superset bundle, **fail-closed**: no system bundle found ⇒ no bundle exported | `SSL_CERT_FILE` *replaces* the root store (`crates/harness/src/run.rs:130-137`); a local-CA-only store would cut codex off from the public internet |
| Linux updater artifact | `createUpdaterArtifacts: "v1Compatible"` ⇒ `.AppImage.tar.gz` + `.sig` (Linux leg only; macOS keeps `true` verbatim) | The signature-covered tar member name `deco_{version}_amd64.AppImage` gives Linux a structural twin of the macOS Info.plist version-pairing check |
| Platform config | New `src-tauri/tauri.linux.conf.json5` overlay (RFC 7396 merge; arrays replaced) | json5 platform files parse (config-json5 enabled on both tauri and tauri-build, `Cargo.toml:79,88`); declarative, applies to every build entry point |
| Runner base | `ubuntu-22.04` for all Linux legs | AppImages inherit the build host's glibc floor; 22.04 is Tauri's documented AppImage baseline |
| Architectures | linux-x86_64 mandatory; linux-aarch64 a purely additive fast-follow | Each manifest key must ship complete forever under hold-back; ARM AppImages can't be cross-compiled (native `ubuntu-22.04-arm` runners are free for public repos) |
| Signing | Same minisign key signs all platforms, step-scoped | One channel, one trust root |
| macOS invariant | **macOS runtime behavior and produced artifacts are unchanged** — proven by byte-identical-argv/parser unit tests, the unchanged macOS boot smoke, and a diff review showing every macOS release step keeps its command text verbatim | Not "no macOS file is edited" — the release workflow *is* restructured and shared Rust helpers *are* refactored; claiming otherwise would be an overstated safety claim (checklist item 7) |
| Linux asset naming | `deco-<version>-linux-x86_64.AppImage{,.tar.gz,.tar.gz.sig}` under tag `native-v<version>` | Mirrors the mac `deco-<v>-aarch64.*` convention; one name shared by the release step, `PLATFORM_ASSETS`, and the web download helper |

---

## 2. Phase 1 — compile & boot on Linux

Goal: a Linux `tauri build` produces a bootable AppImage; login, PATH repair and the
control origin work; org-FS degrades cleanly to empty; CI gates it.

### W1.0 `ci: run apps/native script unit tests` — **prerequisite**

**Goal:** make the plan's two headline safety mechanisms actually execute in CI.
**Problem:** `scripts/test-unit.ts:7-11` (`testRoots`) covers `apps/api/src`,
`apps/api/migrations`, `apps/web/src`, `packages`, `plugins` and the repo-root
`scripts/` — **not** `apps/native/scripts`. `apps/native/package.json:11`
(`"test": "bun test e2e scripts"`) is invoked by no workflow; `native.yml:311` runs
only `bun test e2e`. So `boot-smoke-target.test.ts` (W1.8) and the extended
`native-update-channel.test.ts` (W3.1) would never run — and neither does the
existing `boot-smoke-paths.test.ts` today.
**Change:** add `"apps/native/scripts"` to `testRoots` in `scripts/test-unit.ts`.
**Done when:** `bun run test` at the repo root executes `boot-smoke-paths.test.ts`
and `native-update-channel.test.ts`, and `test.yml` is green.

### W1.1 `fix(native): fetch rclone for Linux triples`

**Goal:** unblock every Linux build — `slug_for_triple` currently returns 1, the
script skips, and the bundler fails resolving the missing `binaries/rclone-<triple>`
externalBin (`tauri.conf.json5:131`).
**Files:** `scripts/fetch-rclone.sh` (`slug_for_triple` 35-41, digest at 73, comment at 34).
**Change:** add `x86_64-unknown-linux-gnu → linux-amd64` and
`aarch64-unknown-linux-gnu → linux-arm64` (verified: `downloads.rclone.org/v1.74.4/`
publishes `rclone-v1.74.4-linux-{amd64,arm64}.zip` plus `SHA256SUMS`; rclone uses Go
arch names). Portable digest — prefer `sha256sum`, fall back to `shasum -a 256`
(macOS has no `sha256sum`, so its path is unchanged):

```bash
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{print $1}'
}
```

Update the stale "macOS only for now" comment. Bundle rclone on Linux from day one
(unused until Phase 2 — the W1.2 gate guarantees it is never spawned) so Phase 2 is
a pure Rust change.
**Done when:** a Linux host produces `binaries/rclone-x86_64-unknown-linux-gnu` with
the pinned sha verified.

### W1.2 `fix(native): gate org-fs off on unsupported platforms`

**Goal:** Linux boots with `org/` reading empty — no rclone spawn, no 2s stall per
dispatch, no respawn log loop — plus a runtime escape for a wedged mount.
**Files:** `crates/local-api/src/sandbox/org_mount.rs` (`warm` 212-222, `wait_ready` 231-252).
**Change:**

```rust
/// Phase 2 flips this to `|| cfg!(target_os = "linux")`.
const PLATFORM_SUPPORTED: bool = cfg!(target_os = "macos");

/// Runtime escape: a wedged FUSE mount, a host without /dev/fuse, or an
/// unexpected rclone failure degrades to the supported empty-`org/` path
/// without waiting for a release.
fn org_fs_enabled() -> bool {
    PLATFORM_SUPPORTED && std::env::var_os("DECOCMS_DISABLE_ORG_FS").is_none()
}
```

Early-return in `warm()` (no task, no claim) and `wait_ready()` (return `false`
immediately — state stays `None`, which means "keep waiting" at line 245, so
short-circuiting avoids the 2s `READY_TIMEOUT` spin). The one-per-sandbox
`[org-fs] … NOT mounted — org/ will read as empty` line
(`sandbox/manager.rs:396-407`) becomes the only user-visible signal. The
claim/settle state machine is untouched.
**Tests (unit, co-located cargo):** `org_fs_enabled` matrix (supported × env set/unset);
`wait_ready` returns false without sleeping when disabled.
**Done when:** a Linux debug build boots a sandbox with empty `org/`, one org-fs log
line, zero rclone processes; setting `DECOCMS_DISABLE_ORG_FS=1` on macOS does the same.

### W1.3 `fix(native): cfg-gate small macOS-isms`

**Goal:** remove hardcoded macOS-isms that break or mislead on Linux; macOS output
byte-identical.
**Files & changes:**

- `crates/upstream/src/login.rs:303-315` — `open_system_browser`: cfg const `OPENER` =
  `open` on macOS, `xdg-open` elsewhere (mirrors `apps/api/src/cli/commands/auth/login.ts:211-227`).
  A missing `xdg-open` flows into the existing soft-fail at 135-142 (URL logged for
  manual open). Fix the "macOS only (v1 desktop target)" doc. No seam or caller changes.
- `src-tauri/src/env_path.rs` — `$SHELL` fallback `/bin/zsh` on macOS (unchanged),
  `/bin/bash` elsewhere (line 68). `fallback_dirs` (127-138): keep the four `$HOME`
  dirs; cfg the system dirs — macOS keeps `/opt/homebrew/bin`, `/usr/local/bin` in
  that order; Linux gets `/usr/local/bin`, `/snap/bin`, `/home/linuxbrew/.linuxbrew/bin`
  (all `is_dir()`-filtered by the caller at 42-45). Reword the launchd-framed module
  doc (1-16): `.desktop`/systemd-user launches inherit a minimal PATH too, and the
  `$SHELL -l -c` probe already handles it.
- `crates/local-api/src/routes/fs.rs:785,796-803` — cfg-gated `RIPGREP_HINT`: macOS
  `brew install ripgrep` byte-identical; Linux `apt install ripgrep` / `dnf install ripgrep`.
- `src-tauri/src/setup.rs:528` — cfg-gated boot-failure font: macOS
  `-apple-system,sans-serif` byte-identical; Linux `system-ui,'Segoe UI',Roboto,Ubuntu,Cantarell,'Noto Sans',sans-serif`.
- `crates/local-api/src/setup/dev.rs:728-787` — **do not** switch `ps -o comm=` to
  `args=`/`command=`: `sandbox/persist.rs:519-521` documents that argv is deliberately
  excluded so child secrets never reach the persisted sidecar. Keep the `ps` invocation
  and parse identical; on Linux override `executable` with the `/proc/<pid>/exe`
  readlink (full path, no argv), falling back to the ps `comm` value. Comment the
  ` (deleted)`-suffix → `Unverifiable` → fail-closed behavior. Extract
  `resolve_executable(pid, ps_name)` as a testable helper.
- `crates/harness/src/watchdog.rs:27-30` — doc-only: BSD `pgrep` excludes ancestors,
  procps excludes only itself; the script's own `$$`-skip (lines 51, 71) is the
  load-bearing exclusion on both. No script change.
- `src-tauri/src/setup.rs:464-499` — doc-only: `preflight_control_dns` works unchanged
  on Linux (getaddrinfo → nsswitch, `files` before `dns`). Add dnsmasq
  `stop-dns-rebind` / libvirt / pfSense examples; bare systemd-resolved passes.

**Tests (unit, co-located cargo):** cfg-gated `fallback_dirs` per OS (macOS order
preserved exactly; Linux contains `/snap/bin`, never `/opt/homebrew/bin`); pure
`resolve_executable` fallback; a cfg(linux) extension of
`observes_a_real_spawned_process_group_identity` asserting `executable.starts_with('/')`.
**Done when:** login opens a browser on Linux, PATH repair finds `/usr/local/bin`
tools, and every existing macOS test passes untouched.

### W1.4 `feat(native): Linux child CA bundle (fail-closed SSL_CERT_FILE)`

**Goal:** spawned CLIs verify the local https origin on Linux, **without** ever
shrinking their public trust store.
**Files & changes:**

- `src-tauri/src/local_tls.rs` — wrap the `security remove-trusted-cert` retire
  (130-135) and `ensure_trusted`/`is_trusted`/`login_keychain_path` (224-269) in
  `#[cfg(target_os = "macos")]`; `ensure()` (98-155) is already portable. Add:

  ```rust
  #[cfg(target_os = "linux")]
  pub fn ensure_child_ca_bundle(app_root: &Path, ca_cert: &Path) -> Result<Option<PathBuf>, TlsError> {
      // Prefer an admin-set store, then the distro defaults.
      const SYSTEM_BUNDLES: &[&str] = &[
          "/etc/ssl/certs/ca-certificates.crt",                  // Debian/Ubuntu/Arch
          "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",   // Fedora/RHEL (extracted)
          "/etc/pki/tls/certs/ca-bundle.crt",                    // Fedora/RHEL (compat)
          "/etc/ssl/ca-bundle.pem",                              // openSUSE
          "/etc/ssl/cert.pem",                                   // Alpine
      ];
      // $SSL_CERT_FILE (if already set and readable) wins over the probe list.
      //
      // FAIL CLOSED: SSL_CERT_FILE *replaces* the root store for Go and
      // rustls-native-certs (see crates/harness/src/run.rs:130-137). If no system
      // bundle is found we return Ok(None) and export nothing — codex then loses
      // the LOCAL MCP origin, which is strictly better than losing all public TLS.
  }
  ```

  Rewritten every boot so CA rotation and distro updates land. Plain write (public
  certs only). Update the module doc: trust is now two-armed (macOS keychain prompt
  vs Linux webview exception — no prompt at all on Linux).
- `crates/local-api/src/lib.rs` — `TlsFiles` (115-124) gains
  `pub child_ca_bundle: Option<PathBuf>`; `start()` extends the `MountCredentials`
  published at 611-617.
- `crates/local-api/src/sandbox/org_mount.rs` — `MountCredentials` (56-74) gains
  `pub ca_bundle: Option<PathBuf>`; correct the `ca_cert` doc's "rclone via Go … never
  need it" claim (macOS-only truth). `spawn_mount` (408-453) sets `SSL_CERT_FILE` only
  when `Some` (inert until Phase 2).
- `crates/harness/src/run.rs` — `McpEndpoint` (111-123) gains `ca_bundle: Option<PathBuf>`;
  `mcp_child_env` (142-156) keeps `NODE_EXTRA_CA_CERTS` exactly as-is (Bun/Node honor it
  identically on Linux) and adds `SSL_CERT_FILE` **only when `Some`**. Rewrite the
  overstated doc at 130-137 ("codex needs neither: rustls-platform-verifier consults the
  keychain" is macOS-only truth) into a per-OS story. Producers: `decopilot.rs:2825`
  **and the test fixture `mcp_fixture()` at `run.rs:958-959`** (the struct derives
  `PartialEq`, so the co-located env tests compare it).
- `src-tauri/src/setup.rs:285-289` — thread `child_ca_bundle`; log a warning when Linux
  yields `None`.

No in-process reqwest client dials the local https origin, so nothing else needs the bundle.
**Tests (unit, co-located cargo):** `concat_pem` — concatenation and trailing newlines;
**no system bundle ⇒ no bundle produced** (assert the refusal, not a local-CA-only file);
`mcp_child_env` — `SSL_CERT_FILE` present exactly when `ca_bundle` is `Some`, absent when
`None`, `NODE_EXTRA_CA_CERTS` unchanged in both. Existing `local_tls` tests (309-378) pass
unchanged.
**Done when:** `<app_root>/tls/ca-bundle.pem` exists after a Linux boot on a distro with a
system bundle, is absent (with a warning) where none is found, and the env plumbing is
asserted on both OSes.

### W1.5 `feat(native): WebKitGTK certificate exception for the control origin`

**Goal:** the Linux webview trusts the local https origin with zero OS-level trust
changes — behind a flag, with the selftest ordering bug closed.
**Files & changes:**

- `src-tauri/Cargo.toml` (23-55):

  ```toml
  # Lockstep with wry 0.55.1's own `=2.0.2` pin (already in Cargo.lock — no new
  # transitive version). Both APIs we need are `#[cfg(feature = "v2_6")]`:
  # web_context.rs:217 allow_tls_certificate_for_host, web_view.rs:2352
  # connect_load_failed_with_tls_errors. Do NOT request v2_40 — webkit2gtk-sys's
  # system-deps metadata would raise the required pkg-config webkit from 2.38 to
  # 2.40 for every consumer, buying nothing.
  [target.'cfg(target_os = "linux")'.dependencies]
  webkit2gtk = { version = "=2.0.2", features = ["v2_6"] }
  ```

- `src-tauri/src/webview_trust.rs` (new; `#[cfg(target_os = "linux")] mod webview_trust;`
  in `lib.rs:63-84`). API chain verified: `Webview::with_webview` →
  `PlatformWebview::inner() -> webkit2gtk::WebView` → `WebViewExt::context()` →
  `WebContextExt::allow_tls_certificate_for_host`.
  1. `install(window, leaf_cert_path, control_host, control_url) -> oneshot::Receiver<Result<(), String>>`
     — inside the `with_webview` closure (GTK main thread): load the **leaf**
     (`gio::TlsCertificate::from_file`; rustls serves only the leaf per
     `local-api/lib.rs:779`, re-minted each launch, so per-boot registration is
     self-consistent), `allow_tls_certificate_for_host` for the control host, connect
     `load-failed-with-tls-errors` as belt-and-braces (host matches control host or a
     `.control_host` subdomain **and** the presented cert `is_same` our leaf ⇒ allow
     that exact cert for that host, `reload()`, return true), drain pending preview
     hosts, then `load_uri(control_url)` and resolve. wry exposes no TLS API and never
     connects this signal — no conflict.
  2. `allow_preview_host(app, host)` — dedup via `Mutex<HashSet<String>>`; park in a
     pending Vec if the window isn't built yet.
  3. Module doc must state the accumulation bound: entries are never removed
     (WebKitGTK exposes no per-host revoke), bounded by one entry per sandbox handle
     per app run and cleared on relaunch since the leaf is re-minted. Log if the set
     exceeds a sanity threshold.
- `src-tauri/src/setup.rs`:
  - **Flag:** the Linux secure origin ships behind `DECOCMS_LINUX_SECURE_ORIGIN`
    (default-off for the first Linux release, flipped after field data). Off ⇒ the
    plain loopback http control origin — the mode the selftest already uses. This is
    the break-glass for a fatal boot path that has no cask to reinstall from
    (checklist item 7).
  - TLS block (239-259): macOS arm untouched; the Linux arm runs only `local_tls::ensure`
    + `ensure_child_ca_bundle` in the same `spawn_blocking` — no pre-boot trust, no prompt.
  - Webview URL (323-327): on Linux with the flag on, build the window at `about:blank`
    (already allowed by `is_allowed_webview_navigation`, line 58) so
    exception-registration-before-first-load is deterministic — wry loads the builder URL
    during construction (`wry 0.55.1 webkitgtk/mod.rs:372`) and `with_webview` dispatches
    strictly after. macOS keeps the control URL.
  - **Selftest ordering guard (load-bearing):** `on_page_load` (376-385) currently evals
    `selftest::BUNDLE_JS` on any `Finished` event. WebKitGTK emits `load-changed`→FINISHED
    for `about:blank`, so the bundle would run against `about:blank`, fail its checks, and
    `selftest.rs:105-116` would `app.exit(1)` **before** `load_uri(control_url)` — a
    deterministic smoke failure that looks like a TLS bug. Make the handler URL-aware:
    skip evaluation unless `payload.url()`'s origin equals the control origin. Land this
    guard **here**, with the `about:blank` staging, and cover it with a cargo unit test
    over the pure predicate.
  - After `builder.build()` (386): await `webview_trust::install(...)`; on `Err` return the
    new `SetupError::WebviewTls(String)` (added at 14-38), whose `show_boot_failure`
    (508-524) hint **names `DECOCMS_LINUX_SECURE_ORIGIN=0`** so a stuck user can self-rescue.
  - Preview-host observer (269-273): Linux sets
    `embedded.preview_host_observer = Some(...)`; `None` default keeps macOS unchanged.
- `crates/local-api/src/lib.rs` — `EmbeddedOptions` (130-160) gains
  `pub preview_host_observer: Option<Arc<dyn Fn(&str) + Send + Sync>>` (default `None`),
  passed to a `set_preview_host_observer` next to the existing `set_preview_host` call (623-625).
- `crates/local-api/src/routes/intercept/sandbox_lifecycle.rs` (66-89, 95-115) —
  `PREVIEW_HOST_OBSERVER: OnceLock` + setter following the `PREVIEW_HOST` convention;
  invoke the observer with `{label}.{base}` **before** returning the URL in the per-handle
  branch. Required because the exception API is exact-host (no wildcard) and
  `load-failed-with-tls-errors` does not fire for iframe subframes — proactive
  registration is the only path for previews.
  **Extract the pure core first:**
  `fn preview_url_for(base, scheme, port, handle, observe: Option<&dyn Fn(&str)>) -> Option<String>`,
  leaving `preview_url()` a thin wrapper over the three globals. `PREVIEW_HOST` is a
  process-global `OnceLock` written only by production code; a test that set it would
  irreversibly poison the existing
  `preview_url_reports_the_listener_only_once_it_is_bound` (line 756) under cargo's
  in-process parallel harness.

**Tests (unit, co-located cargo):** pure `preview_url_for` — per-handle vs single-label
mode, observer fires with `<label>.<base>` in per-handle mode only, no global touched;
the selftest URL predicate. The load-bearing proof is W1.9's secure-mode selftest.
Manual hardware pass before relying on previews (no signal fallback exists for iframes).
**Done when:** a Linux debug build with the flag on boots to the control origin over
https with no OS trust installed; with the flag off it boots over http; boot failure
surfaces the new variant with the escape-hatch hint.

### W1.6 `feat(native): Linux credential store namespace`

**Goal:** close a silently-broken invariant before Linux dev builds exist.
**Problem:** `keyring = "4"` is unconditional (`crates/upstream/Cargo.toml:48`) and
`Cargo.lock` already carries `zbus-secret-service-keyring-store`, so `KeychainTokenStore`
(used at `session.rs:974` outside `LOCAL_API_TOKEN_STORE=memory`) works on Linux via
D-Bus Secret Service. But `keyring_service()` (`tokens.rs:660-674`) selects
`DEV_KEYCHAIN_SERVICE` only when `keychain_access_kind(debug, macos) == StableDevHelper`,
and `keychain_access_kind` (549-555) requires `debug && macos` — so a **Linux debug build
writes into `com.decocms.studio`, the release namespace**, contradicting CLAUDE.md's
"Debug sessions stay in the … `com.decocms.studio.dev` namespace" invariant.
**Change:** separate the two concerns — *which backend* (helper vs direct, still
`debug && macos`) from *which namespace* (dev vs release, `debug` on every OS). Update
`tokens.rs`'s module doc and the CLAUDE.md sentence to state the per-OS story.
**Tests (unit, co-located cargo):** pin the full matrix (macOS/Linux × debug/release) for
both backend kind and service name.
**Done when:** a Linux debug build never touches the release namespace; login persists
across relaunch on a GNOME desktop; with no Secret Service running the app shows the
keyring-unavailable screen rather than failing opaquely.

### W1.7 `feat(native): Linux bundle overlay, icons, and AppImage-gated updater`

**Goal:** `tauri build` on Linux produces an AppImage without touching the macOS config;
the updater can never clobber a non-AppImage binary.
**Files & changes:**

- `src-tauri/tauri.linux.conf.json5` (new):

  ```json5
  // Linux-only overlay — merged over tauri.conf.json5 as a JSON Merge Patch
  // (RFC 7396): arrays are REPLACED wholesale. macOS/dev builds never read it.
  //
  // INVARIANT: `createUpdaterArtifacts` NEVER belongs here. Committed, it would
  // fail every secretless fork/PR build with a signing error — that is why it
  // lives only in release-native.yaml's --config overlay (see its comment at
  // release-native.yaml:272-274). native.yml's ubuntu tauri-build leg is the
  // canary: it builds unsigned and secretless and goes red the moment this
  // invariant is broken.
  {
    bundle: {
      targets: ["appimage"],
      category: "DeveloperTool",
      icon: ["icons/32x32.png", "icons/64x64.png", "icons/128x128.png",
             "icons/128x128@2x.png", "icons/256x256.png", "icons/512x512.png"],
    },
  }
  ```

  Note: **no `linux.appimage.bundleMediaFramework` block.** `false` is already the
  serde default (`tauri-utils 2.9.3 config.rs:321-329`); setting it explicitly saves
  nothing (the ~15-35 MB is what `true` would *add*).
- `src-tauri/icons/256x256.png`, `512x512.png` (new, rendered once from the 1024px
  `icons/icon.png`): Linux bundlers derive hicolor dirs from actual PNG dimensions, and
  `128x128@2x` lands in a scale dir some DEs skip. `64x64.png` already exists on disk but
  is unreferenced by the base config — list it only in the overlay. Base `icon` array untouched.
- `src-tauri/tauri.conf.json5`: **no value edits**; extend the externalBin comment
  (123-130) to cover the AppImage case — verified at tag `tauri-cli-v2.11.4` that the
  AppImage reuses debian's `generate_data`, copying externalBin into `usr/bin` with the
  `-<target-triple>` suffix stripped, so `current_exe().parent().join("rclone")` resolves
  inside the mounted squashfs.
- `src-tauri/src/updater.rs:179-195` — day-one safety gate, after the placeholder-version gate:

  ```rust
  // Linux: the plugin swaps the file $APPIMAGE points at, in place. Run from a
  // raw binary (dev checkout, extracted AppDir, future deb/rpm) it would
  // overwrite current_exe() itself — never spawn there. The plugin has no such
  // guard: tauri-plugin-updater 2.10.1 wires executable_path from env.appimage
  // and install_appimage rewrites it with no "not an AppImage" error.
  #[cfg(target_os = "linux")]
  if std::env::var_os("APPIMAGE").is_none() {
      tracing::info!("self-update disabled: not running from an AppImage");
      return false;
  }
  ```

**Done when:** `bunx @tauri-apps/cli@2.11.4 build` on ubuntu-22.04 yields
`target/release/bundle/appimage/deco_<ver>_amd64.AppImage`, and a dev binary never spawns
the updater task.

### W1.8 `feat(native): boot-smoke Linux target`

**Goal:** the boot smoke gates the shipped Linux artifact's packaging exactly as the macOS
smoke gates the `.app`.
**Files & changes:**

- `scripts/boot-smoke-target.ts` (new pure helper, mirroring `boot-smoke-paths.ts`):
  `resolveSmokeTarget(platform, desktopDir)` returning `bundlesArg`
  (`["--bundles","app"]` | `["--bundles","appimage"]`), `bundleDir`,
  `isBundleArtifact(name)` (`deco.app` | `deco_*_amd64.AppImage`),
  `launchedBinaryRelPath` (`Contents/MacOS/deco` | `squashfs-root/usr/bin/deco`), and
  per-platform `sweepPatterns`.
- `scripts/boot-smoke.ts` — route the four hardcoded macOS spots through the target:
  `APP_BUNDLE` (56-59); `binaryPath()` (101-118) — on Linux run `--appimage-extract` into
  `smokePaths.root` (so `cleanupSmokeDir` reclaims it; no FUSE needed) and launch the inner
  `usr/bin/deco`, keeping the child-process model unchanged; **add a Linux-only assertion
  that `rclone` sits beside the inner binary** (the externalBin staging tripwire; macOS
  deliberately doesn't assert this today, so macOS behavior is identical);
  `ensureBuilt` (135-186) takes `target.bundlesArg` and — in the same commit — **pins its
  `bunx @tauri-apps/cli@latest` (lines 173,177) to `@2.11.4`**, so the AppImage the smoke
  validates is produced by the same bundler as the release (W3.2's version-pairing check
  depends on that member name); `sweepForBinaries` (214-230) keeps all three existing
  patterns and appends the extraction pattern. Env block (262-287) unchanged —
  `LOCAL_API_TOKEN_STORE=memory` avoids any Secret Service dependency.
**Tests (bun unit, co-located — pure per TESTING.md; runs in CI thanks to W1.0):**
`resolveSmokeTarget("darwin")` returns the exact current values (proving the refactor
changes nothing on macOS); `("linux")` returns the appimage args/dir, a matcher accepting
`deco_0.1.0_amd64.AppImage` and rejecting `deco.AppDir`, the extraction rel path, and sweep
patterns including the existing ones; unknown platform throws. Route extraction paths
through `resolveBootSmokePaths` and assert they stay under the validated root.
**Done when:** `xvfb-run -a bun run --cwd apps/native smoke:boot` passes on ubuntu-22.04.

### W1.9 `feat(native): Linux secure-mode selftest gate`

**Goal:** the automated proof for the TLS design — leaf exception, `fetch()`, and the one
behavior unverifiable from source: `wss://` through WebKit's network-process allow-list.
**Change:** an env gate that keeps the selftest port but sets `ControlOrigin.secure=true`
on Linux (possible there because trust needs no keychain/prompt; selftest is plain-http on
both OSes today per `control_origin.rs:59-62`). Under it the real WebKitGTK webview boots
against the rcgen leaf; the selftest asserts page load, a `fetch()` to the control origin,
and a WebSocket connect. Depends on W1.5's `on_page_load` URL guard.
**Done when:** the Linux CI smoke passes with `secure=true`. A `wss` failure triggers the
designated fallback discussion (`TLSErrorsPolicy::Ignore`) under explicit sign-off — never
silently.

### W1.10 `ci: ubuntu legs for rust-checks, tauri-build, contract-suite`

See §5. **Sequencing:** these land with or after W1.1-W1.9 — never before, or every PR
goes red (Gotcha #7).
**Done when:** both matrix legs of `rust-checks`, `tauri-build` and `contract-suite` are
green on a PR touching `apps/native`, and appear as separate required checks.

---

## 3. Phase 2 — org-FS Linux mount port

Port the daemon's already-proven Linux path (`packages/sandbox/daemon/org-fs/mounter.ts`,
`detach-mount.ts`) into `org_mount.rs`. Ship as two PRs so the parser/argv tests land
compiled-on-macOS before any behavior flips.

### W2.1 `feat(native): portable org-fs helpers`

**Goal:** all Linux logic exists as pure, unit-tested helpers compiled on both OSes; zero
behavior change.
**Files:** `crates/local-api/src/sandbox/org_mount.rs`.
**Changes:**

- Extract `fn mount_args(volume, mountpoint) -> Vec<OsString>` from `spawn_mount` (415-435):
  a shared tail (vfs cache / write-back / dir-cache / timeouts / retries / read-only) so the
  OSes can't drift; macOS keeps `nfsmount` + `--option actimeo=1,locallocks,soft,timeo=100,retrans=2,nobrowse`
  **byte-identical**; Linux uses subcommand `mount`, `--attr-timeout 1s`, **no `--allow-other`**
  (mounter.ts scopes that to the privileged-sidecar/different-uid cluster split; desktop is
  single-uid, and omitting it removes the `/etc/fuse.conf user_allow_other` requirement
  entirely), plus `--file-perms 0755` for read-only volumes (mirrors `mounter.ts:94` — the
  manifest carries no mode bits and public skill scripts need `+x`).
- `parse_proc_mounts_line` + `unescape_octal` beside the untouched `parse_mount_line`
  (607-617). Compile both parsers on both OSes (`#[cfg(any(test, target_os = …))]`) so the
  whole suite runs on macOS CI. fstype const: macOS `"nfs"`, Linux `"fuse.rclone"`.
- `fn detach_commands(mountpoint) -> Vec<Vec<String>>`: macOS exactly `[umount -f]`; Linux
  `[fusermount3 -uz, fusermount -uz, umount -l]` (fuse3's binary name first — the daemon's
  plain `fusermount` is a fuse2 compat name on modern distros; all lazy so a wedged kernel
  never stalls).
- Widen `orphaned_rclone_pids`'s third predicate (587) from `"nfsmount"` to `"mount wd:"` —
  `"nfsmount wd:"` contains it, so one substring covers both OSes with no cfg while
  preserving every never-kill guarantee.

**Tests (unit, co-located, all pure):** `parse_proc_mounts_line` on a real fuse.rclone line,
an ext4 line, a `\040`-escaped mountpoint, garbage → None; Linux-format `stale_mountpoints`;
the existing macOS TABLE tests (625-677) pass unmodified; `detach_commands` order per OS;
`orphaned_rclone_pids` against a Linux AppImage argv plus all four existing negative cases
(696-708) re-asserted under the widened predicate; `mount_args` — macOS argv byte-identical
to today's, Linux contains `mount`/`--attr-timeout`/`--file-perms` and **not**
`--allow-other`/`--option`.
**Done when:** `cargo test` green on macOS with the full new suite; no runtime change either OS.

### W2.2 `feat(native): enable org-fs on Linux`

**Changes:** flip `PLATFORM_SUPPORTED` to include Linux (`org_fs_enabled()` from W1.2 keeps
the runtime kill switch). `mounted_paths()` (470-486) and `stale_mountpoints` (597-605) route
through a per-OS `mounted_table()` — Linux reads `/proc/self/mounts` (no subprocess), macOS
keeps spawning `mount`. `wait_until_mounted` (460-468) unchanged except the fstype const.
`force_unmount` (516-536) loops `detach_commands`, breaking on first success. Un-gate
`prune_stale_mounts` (494) to `if !org_fs_enabled()`. `kill_orphaned_servers`'s
`ps -eo pid=,command=` stays (`command=` aliases `args=` in both BSD ps and procps-ng).
`rclone_binary()` (260-271): cfg the dev-fallback triple suffix; fix the duplicated doc at 254
and the `<App>.app/Contents/MacOS/` claim to cover AppImage `usr/bin`. W1.4's `SSL_CERT_FILE`
becomes live here.
**Tests:** covered by W2.1 units, plus a manual hardware checklist (needs `/dev/fuse`, so not
a unit test per TESTING.md): mount appears in `/proc/self/mounts` as `fuse.rclone` (confirming
the literal), degrade-to-empty on a stopped mount, boot sweep reclaims a SIGKILLed session's
ghosts, rclone verifies the local origin via the CA bundle.
**Done when:** `org/` mounts, reads, writes and unmounts on a real Linux desktop with fuse3;
macOS argv/parser/unmount provably byte-identical via W2.1's tests.

### W2.3 `[chore]: docs — org-fs Linux story`

**Files:** `apps/native/docs/org-fs-plan.md` — the Non-goals bullet (~329-336) narrows to
Windows-only (WinFsp rationale stands), **and** decision-table row 8 at **line 41**
("macOS only — every desktop build/sign job runs on macos-latest … other platforms would be
untested weight") is rewritten, since this plan makes it false. Add a Linux section: rclone
`mount` via FUSE, no `--allow-other` on desktop, fusermount3 detach chain,
`/proc/self/mounts` as the table source, fuse3 as the only host runtime dependency.

---

## 4. Phase 3 — release/updater Linux leg + web download surface

### W3.1 `feat(ci): multi-platform latest.json builder`

**Files:** `scripts/ci/native-update-channel.mjs` (107-148, 172-181) + its test.
**Change:** replace the single `signature` param with `signatures: Record<platformKey, sig>`
and a module-level `PLATFORM_ASSETS` table:
`{ "darwin-aarch64": v => \`deco-${v}-aarch64.app.tar.gz\`, "linux-x86_64": v => \`deco-${v}-linux-x86_64.AppImage.tar.gz\` }`
(key `linux-x86_64` verified from tauri-plugin-updater 2.10.1's `updater_os`/`updater_arch`;
the plugin tries `{os}-{arch}-{installer}` then falls back to `{os}-{arch}`). **Throw** if any
table key is missing from `signatures`, any value is empty/whitespace, or an unknown key is
passed — enforcing the line-111 warning by construction. URLs stay derived against the
immutable `native-v<version>` release. `--sig-file` becomes a repeatable `key=path`.
`shouldPromote` unchanged.
Add a **coverage-regression guard**: `shouldPromote` compares only `version`, so a repair
dispatch from a pre-Linux ref (or a revert) could `--force` a darwin-only manifest over the
two-platform one, silently stranding every Linux client. Export a helper asserting the new
manifest's `platforms` key set is a superset of the currently-published one, called in the
promote job before upload.
**Tests (bun unit):** two-platform exact-shape manifest; throws on missing/whitespace sig and
unknown key; repeatable-flag accumulation and malformed-pair rejection; superset comparison
(equal ⇒ ok, strict subset ⇒ error).
**Done when:** the builder cannot emit a partial manifest, and a coverage regression fails the run.

### W3.2 `fix(native): Linux updater version-pairing check`

**Goal:** port the downgrade/manifest-pairing defense (macOS: Info.plist
`CFBundleShortVersionString`, `updater.rs:336-347,374-410`) to Linux.
**Change:** add `appimage_member_version(targz) -> Result<String, String>`: iterate tar
entries, find the single depth-1 member ending `.AppImage`, expect exactly
`[product, version, arch]` on `split('_')`, return the version. Valid because the Linux leg
ships `createUpdaterArtifacts: "v1Compatible"` and the member **name is covered by the
minisign signature** (verified from tauri-bundler at tag `tauri-cli-v2.11.4`:
`create_tar_from_src` appends the file under its own name; `linuxdeploy.rs` formats
`{product}_{version}_{arch}` with `amd64` for x86_64). Dispatch by cfg at the call site only;
keep both functions and their tests compiled on all OSes (per the always-compile note at
412-415). Comments elsewhere: the module doc (15-24) and stage comment (349-351) note that
deferred install is also correct on Linux (`install_appimage` renames a backup, writes at
`$APPIMAGE`, the kernel keeps the running mount alive, and restart respawns via
`current_binary()` = `env.appimage`); soften `shutdown.rs:31-37`'s "breaks macOS Keychain
access" to name the rationale as macOS-specific while keeping the ordering cross-platform.
`routes/update.rs` is already OS-agnostic.
**Tests (unit, cargo, always-compiled):** happy path via a synthetic tar.gz with one
`deco_4.151.0_amd64.AppImage` member (mirroring the `bundle_short_version` test at 541-574);
rejects depth-2 members, non-3-segment names, non-gzip bytes; the mismatch error string preserved.
**Done when:** a manifest pairing a high version with an old validly-signed Linux artifact
fails closed, exactly as macOS does.

### W3.3 `ci: release-native Linux leg`

The pipeline restructure itself — see §5.
**Done when:** a `workflow_dispatch` on a bumped version produces both artifacts, uploads all
seven assets to `native-v<v>`, and promotes a two-platform `latest.json`; a dispatch against a
tag missing the Linux assets refuses to promote; a **forced build-leg failure** still publishes
the macOS release + cask bump **and** files the alert issue.

### W3.4 `feat(web): Linux download surface`

**Files & changes:**

- `apps/web/src/components/download-app-dialog.tsx` (16-29, 44-77): add
  `isLinuxDesktopBrowser()` — `/Linux/.test(navigator.platform) && !/Android/.test(navigator.userAgent) && !('ontouchend' in document)`
  (Android reports "Linux…"; the touch exclusion mirrors the mac gate so the two age
  together; ChromeOS matches and is offered an AppImage — accepted for v1, commented).
  **Branch the whole dialog, not just the body:** `DialogDescription` (line 49) currently
  renders `t("downloadApp.description")` = "The app installs from your **Mac's Terminal**…",
  and the footer carries `terminalHint` + `appleSiliconNote`. Linux selects
  `linuxDescription`, a download button, `linuxChmodHint` and `linuxArchNote`. Extract the
  pure helper:

  ```ts
  export function appImageDownloadUrl(version: string): string {
    return `https://github.com/decocms/studio/releases/download/native-v${version}/deco-${version}-linux-x86_64.AppImage`;
  }
  ```

  built from `__STUDIO_VERSION__` (`globals.d.ts:1`; versions are lockstep per the release
  workflow's assert). Do **not** use `releases/latest/download` — other workflows publish
  releases here, so "latest" is not guaranteed to be a `native-v` tag.
- `apps/web/src/i18n/en/download-app.ts` + `pt-br/download-app.ts`: new keys
  `downloadApp.linuxDescription`, `.downloadAppImage`, `.linuxChmodHint`, `.linuxArchNote`,
  `.allReleases`, `.installOnLinux` — flat, `as const`, pt-br mirrored (the
  `satisfies Record<keyof typeof en, string>` makes omission a compile error).
- `apps/web/src/components/account-popover.tsx` (406-418): gate becomes
  `(isMacDesktopBrowser() || isLinuxDesktopBrowser()) && !isDesktopApp`; label branches per
  platform.
- `apps/web/src/components/chat/no-ai-provider-empty-state.tsx` (105-110): widen the
  `offerDownload` gate identically; update the macOS-framed comment.
- `apps/web/src/desktop/keychain-unavailable-screen.tsx` + `i18n/en/common.ts` (43-47) +
  pt-br: add `common.desktopKeychainUnavailable.descriptionLinux` ("…could not access your
  system keyring…"), selected by a bare `/Mac/.test(navigator.platform)` check (the browser
  gate's touch heuristic is meaningless inside the desktop webview). The mac key stays
  byte-identical.
- `apps/web/public/install.sh` (29-33): stays macOS-only; improve the non-Darwin message to
  point at the AppImage on the releases page.
- `apps/web/src/lib/release-feed.ts`: no change — the "Apple Silicon only" card is dated
  seeded content; a Linux entry belongs to the launch, not this port.

**Tests (bun unit, co-located; precedent `version-check-dialog.test.ts`):**
`appImageDownloadUrl` exact shape including the `native-v` prefix and
`-linux-x86_64.AppImage` suffix — drift from the release naming becomes a deliberate
contract-test update. `bun run check` proves pt-br completeness. (Verified: **no e2e depends
on this copy** — `packages/e2e` and `apps/native/e2e` have zero hits for `downloadApp`,
`install.sh`, "Install on Mac", `isMacDesktopBrowser` or `AppImage`.)
**Done when:** a Linux browser sees the AppImage download and **no string containing "Mac",
"Terminal" or "Apple Silicon" renders**; mac users see exactly today's dialog; `check`, `lint`
and `fmt` pass.

### W3.5 `[chore]: docs — README + Linux runbook`

**Files:** `apps/native/README.md` — the updater runbook (148-171) gains: the channel now
carries `darwin-aarch64` + `linux-x86_64`; promotion is all-platforms-or-nothing while
**publication is not** (a failed Linux leg holds back the manifest but still ships the macOS
release and cask bump); Linux break-glass = re-download the AppImage from the releases page
(no cask); the kill-switch env var works as-is. **Also** update the Distribution row (line 9,
"signed macOS application") and the Overview paragraph (21-23, "The current release targets
macOS") — leaving them would be an overstated scope claim.
**Done when:** an on-call engineer can execute the hold-back repair from the runbook alone.

---

## 5. CI & release pipeline changes

Preserved invariants, explicitly: **fork-safety** (secret-emptiness gates stay), **tag
idempotence**, **step-scoped secrets**, **pinned CLI**, **manifest-after-assets** (now
after *all platforms'* assets), **concurrency group**.

### `.github/workflows/native.yml` (Phase 1 — lands with/after the cfg work)

- **rust-checks** (105-169): `strategy: matrix: os: [macos-latest, ubuntu-22.04]`. Linux-only
  apt step:

  ```yaml
  - name: Install Linux system deps
    if: runner.os == 'Linux'
    run: |
      sudo apt-get update
      sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
        libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf xdg-utils
  ```

  Rewrite the now-false job-header comment (106-113, "macOS-only … won't compile on Linux") to
  state that the ubuntu leg gates the Linux port and name the apt surface. The rclone cache key
  already varies on `runner.os` (line 157).
- **tauri-build** (321-451): ubuntu-22.04 leg — apt + xvfb, build via the pinned CLI with
  targets from `tauri.linux.conf.json5`, upload the AppImage as artifact `deco-appimage`, then
  the smoke under `xvfb-run -a` with `DECOCMS_DISABLE_AUTO_UPDATE=1`. Use a **clean tauri tools
  cache** so a current `linuxdeploy-plugin-appimage` (static type-2 runtime) is fetched, and
  assert the runtime is static **before any extraction** — `ldd`/`readelf -d` on the AppImage
  file itself, failing if it mentions `libfuse.so.2`. (Asserting after `--appimage-extract`
  would be self-defeating: a legacy libfuse2-linked runtime cannot execute the extract at all,
  so the smoke would fail first and mask the diagnosis.) `Upload .app artifact` and the Keychain
  smoke comment become `if: runner.os == 'macOS'`. **The Linux legs of native.yml must never
  declare `environment:` or map any secret** — that is what makes this job the
  `createUpdaterArtifacts` canary. Pin native.yml's `@tauri-apps/cli@latest` (line 414) to
  `2.11.4` while here.
- **contract-suite** (276-311): same 2-OS matrix (`cargo build --release --bin local-api` +
  the same absolute `LOCAL_API_E2E_CMD`; `helpers.ts` is env-only and platform-neutral).
  `upstream-auth-proxy.e2e.test.ts:54` opts into the keychain token store (needs D-Bus) — ship
  `describe.skipIf(process.platform !== "darwin")` for v1.
- **native-scripts tests:** W1.0 makes `apps/native/scripts` part of the root `bun run test`
  (`test.yml`), so no new job is needed here.
- **daemon-e2e-vs-rust** stays macOS-only (its gate is an exact pinned fail-set; a Linux leg
  needs a per-OS allowlist — deferred).

### `.github/workflows/release-native.yaml` (Phase 3 — W3.3)

Restructure the single `release` job (85-483) into **five**. The key correction versus a naive
matrix split: **only channel promotion is held back by the Linux leg.** Coupling release
creation and the cask bump to Linux health would freeze the sole macOS acquisition path
(`install.sh` is a pure cask wrapper) and the documented break-glass channel.

1. **`plan`** (ubuntu-latest, **no `environment:`**, secretless): read version (113-118),
   skip-if-already-released (127-142), api/native lockstep assert (149-157). Outputs
   `release`, `version`, `tag`. The updater-signing emptiness assert moves into each build leg
   (below) — those already declare the environment, and keeping `plan` secretless preserves
   today's step-scoping instead of widening the environment to a second job.
   *(Verified: `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)` exist **only** in the `native-release`
   environment, so a job without it cannot probe them.)*
2. **`build`** matrix — `include: [{os: macos-latest, target: darwin-aarch64}, {os: ubuntu-22.04, target: linux-x86_64}]`,
   `needs: plan`, `if: needs.plan.outputs.release == 'true'`, `environment: native-release`.
   First step per leg: the existing `HAVE_SIGNING_KEY != 'true'` emptiness assert.
   - macOS leg: every current step **verbatim** (cert import, signing env, pinned-CLI build with
     its `createUpdaterArtifacts: true` overlay, package assets); Apple-only steps get
     `if: runner.os == 'macOS'` and keep their existing secret-emptiness fork gates.
     *(Note: no `APPLE_*` secret is currently configured at repo or environment level, so those
     steps are no-ops today and releases ship unsigned — the emptiness gates are load-bearing on
     the real path, not just for forks.)*
   - Linux leg: apt + rclone + frontend build, then the pinned CLI with a **minimal** overlay
     `--config '{"version": V, "bundle": {"createUpdaterArtifacts": "v1Compatible"}}'` (targets
     come from the platform file; a minimal overlay reduces the untested overlay×platform-file
     merge surface). **Fetch and verify the AppImage tooling in a dedicated step *before* the
     signing key is in scope:** download `linuxdeploy` + `linuxdeploy-plugin-appimage` at pinned
     URLs, `sha256sum -c` against checksums committed beside `fetch-rclone.sh` (the same pattern
     that script already uses), place them in the tauri tools cache, and run the static-runtime
     assertion there. Otherwise `tauri build` would fetch and exec unpinned third-party binaries
     in the one step holding the private key — a strictly new exposure surface versus macOS.
     Do not map `APPLE_*` into this leg.
   - Each leg uploads via `actions/upload-artifact` (`release-assets-${{ matrix.target }}`),
     **not** to the GitHub release. The cask's `zip.sha256` travels **as a file** inside the
     macOS artifact (matrix job outputs are last-writer-wins).
3. **`publish`** (ubuntu-latest, `needs: [plan, build]`, `if: !cancelled() && needs.plan.outputs.release == 'true'`):
   download `release-assets-*` (`merge-multiple: true`) and create-or-update the release with
   **whatever legs succeeded**, then bump the Homebrew cask from the macOS artifact's
   `zip.sha256` (gate the cask steps on the macOS assets being present).
   **Assets are write-once:** list the tag's existing assets and upload only the missing ones —
   **drop `--clobber` for `native-v*` tags entirely** (keep it only for the rolling
   `native-updates` manifest). Rationale: builds are not reproducible, so a repair dispatch for
   an already-released version would replace `deco-$V-aarch64.app.tar.gz` with new bytes while
   `shouldPromote` returns `{promote:false}` for `cmp === 0` — leaving `latest.json`'s old
   signature pointing at new bytes and breaking self-update for every macOS client, and
   likewise invalidating the cask's pinned `sha256`.
   The cask bump keeps its `vars.RELEASE_BOT_APP_ID` gate; also gate the token step on
   `secrets.RELEASE_BOT_APP_PRIVATE_KEY != ''` so a missing key warns instead of failing after
   publication. *(Verified: that secret is **repo-level**, so `publish` needs no `environment:`
   for it.)*
4. **`promote`** (ubuntu-latest, `needs: [plan, build, publish]`, **`if: needs.build.result == 'success'`** — this
   is the hold-back): verify the immutable release holds **every** platform's updater asset,
   then build and upload the manifest. Fetch the asset list **once into a file** — a
   `gh … | grep -q` pipeline under `set -o pipefail` can take SIGPIPE(141) on a *successful*
   match and spuriously refuse to promote:

   ```bash
   gh release view "$TAG" --repo "$GITHUB_REPOSITORY" --json assets --jq '.assets[].name' > "$RUNNER_TEMP/assets.txt"
   for A in "deco-$V-aarch64.app.tar.gz" "deco-$V-aarch64.app.tar.gz.sig" \
            "deco-$V-linux-x86_64.AppImage.tar.gz" "deco-$V-linux-x86_64.AppImage.tar.gz.sig"; do
     grep -qxF "$A" "$RUNNER_TEMP/assets.txt" || { echo "::error::$A missing from $TAG — refusing to promote"; exit 1; }
   done
   ```

   Derive the signatures from **what is on the release** (`gh release download "$TAG" -p '*.sig'`),
   not from this run's build output, so manifest↔asset pairing is correct regardless of throttle,
   force or repair. Then run W3.1's superset check against the currently-published manifest before
   uploading.
5. **`alert`** (ubuntu-latest, `needs: [plan, build, publish, promote]`,
   **job-level** `if: always() && (contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled'))`):
   the existing issue create/comment body (464-483) plus the failing job/leg name and
   `needs.plan.outputs.tag` (with a fallback when `plan` itself failed). **This must be its own
   job:** a step-level condition inside a job that is *skipped* by an upstream failure never
   evaluates — `always()` included — so the most likely new failure mode (Linux leg red) would
   otherwise be silent, which is precisely the unbounded-invisible-staleness hazard the alert
   exists for.

Extend the CLI-pin comment (264-268): a bump must also re-verify the AppImage member name
`{product}_{version}_{arch}` that W3.2's pairing check depends on.

---

## 6. Open questions

Each with its recommended default.

1. **`/proc/self/mounts` fstype literal for an rclone FUSE mount** (`fuse.rclone` expected).
   Default: build W2.1 against it; confirm with one manual `rclone mount` before merging W2.2.
2. **Does the macOS NFS path expose `+x` on public skill scripts today?** Decides whether Linux
   `--file-perms 0755` is a fix or a divergence. Default: ship it (proven daemon behavior for
   the same content); check on a Mac to classify.
3. **WebKit allow-list equality semantics** (presented-cert comparison; accumulate vs overwrite).
   Default: register the leaf only; the main-frame signal self-corrects, but preview iframes have
   no fallback — one manual hardware pass gates preview support.
4. **`wss://` through the network-process per-host allow-list.** Default: W1.9 asserts it; on
   failure escalate `TLSErrorsPolicy::Ignore` for explicit sign-off, never silently.
5. **codex (rustls-native-certs) honoring `SSL_CERT_FILE`.** Default: ship the bundle; verify on
   hardware. Failure mode is codex-only tool loss (claude is unaffected via `NODE_EXTRA_CA_CERTS`).
6. **glib-networking inside the AppImage** — without it every https load fails
   `G_TLS_ERROR_UNAVAILABLE`. Default: extract the first CI AppImage and check the gio modules;
   the secure-mode smoke is the automated tripwire.
7. ~~**Whether the whole workspace compiles on Linux**~~ — **RESOLVED** (PR #5509, first ubuntu
   run): `cargo clippy --workspace --all-targets -- -D warnings` is clean on ubuntu-22.04,
   compiling `webkit2gtk`/`webkit2gtk-sys` 2.0.2 against `libwebkit2gtk-4.1-dev` 2.50.4. The
   apt surface in §5 is sufficient as written — `libdbus-1-dev` was **not** needed.
8. **Xvfb WebKit knobs** (`WEBKIT_DISABLE_DMABUF_RENDERER=1`, `WEBKIT_DISABLE_COMPOSITING_MODE=1`).
   Default: don't set them; add on first observed hang (surfaces as the smoke's 60s deadline kill).
9. **rclone Linux zip inner layout** (assumed `rclone-<ver>-linux-amd64/rclone`). Default: assume;
   the first Linux fetch verifies.
10. **`tauri dev` externalBin placement on Linux.** Default: assume it matches macOS; a wrong
    assumption breaks only the Phase-2 dev loop, not release.
11. **Release `--config` overlay × `tauri.linux.conf.json5` merge.** Both merge into one effective
    config; last-writer-per-key is verified, the combination is untested. Default: keep the
    release overlay minimal and inspect the effective config on the first release build.
12. ~~**`dev-signing-runner.e2e.test.ts` on Linux**~~ — **RESOLVED** (PR #5509): it misbehaves.
    The fixtures stub `security`/`codesign`, but the assertions call BSD `stat -f %Lp`, which
    GNU coreutils rejects. The suite is now `skipIf(platform !== "darwin")` — it exercises
    macOS-only signing scripts that have no Linux counterpart.

*Closed during planning:* `RELEASE_BOT_APP_PRIVATE_KEY` is repo-scoped (so `publish` needs no
environment); `TAURI_SIGNING_*` is environment-scoped only (so the assert must live in the build
legs); no e2e suite depends on the mac-only download copy.

*Closed by the first ubuntu CI run (PR #5509):* the whole workspace compiles and lints on Linux
(OQ7); `dev-signing-runner` needs the macOS gate (OQ12); the keychain-backed auth-proxy suite
needs it too — `LOCAL_API_TOKEN_STORE=keychain` cannot reach a D-Bus Secret Service on a CI
runner, so restoring that coverage means standing up `gnome-keyring-daemon`, not relaxing the
suite. Also newly pinned rather than assumed: `portable-pty`'s signal exit code differs by libc
(BSD `strsignal` suffixes the number, glibc does not), so `exit_info_from_pty` yields `128+sig`
on macOS and `1` on Linux — already the documented fallback, now asserted per platform.

---

## 7. Risks & mitigations

- **Hold-back stalls updates when the Linux leg breaks.** Scoped to the manifest only —
  publication and the cask still ship. Mitigations: the dedicated `alert` job, the runbook's
  `workflow_dispatch` repair, and a drill that forces a build-leg failure (not just a finalize
  failure) before relying on it.
- **A fatal Linux boot path has no cask to reinstall from.** Mitigated by the default-off
  `DECOCMS_LINUX_SECURE_ORIGIN` flag, the escape-hatch hint in `show_boot_failure`, and
  `DECOCMS_DISABLE_ORG_FS` for a wedged mount.
- **CI legs landing before the port compiles turn every PR red.** Sequence W1.10 with or after
  W1.1-W1.9 (Gotcha #7).
- **Stale linuxdeploy cache emits libfuse2-dependent AppImages.** Pinned + checksummed tooling
  fetch, plus the pre-extraction `ldd` assertion.
- **Bundler AppImage member name is frozen only by the CLI pin** (W3.2 depends on it). The pin
  plus the extended bump-comment force re-verification; boot-smoke is pinned to the same version.
- **`webkit2gtk =2.0.2` must move in lockstep with tauri upgrades** or app-side types stop
  unifying with `PlatformWebview::inner()`. Mitigated by the exact `=` pin and its comment.
- **Preview-host exceptions accumulate for the process lifetime** (no per-host revoke exists).
  Bounded at one entry per sandbox handle per run, cleared on relaunch; documented in the module
  doc with a threshold log.
- **Cross-area asset-name contract**: the web helper, the release rename, and `PLATFORM_ASSETS`
  all encode `deco-<v>-linux-x86_64.AppImage(.tar.gz)`. The single helper plus exact-shape unit
  tests make drift a deliberate change.
- **Arch vocabulary trap**: bundler `amd64`/`aarch64`, updater key `x86_64`/`aarch64`, rclone
  `amd64`/`arm64`. All mappings are explicit tested constants — never inferred.
- **ubuntu-22.04 EOL horizon**: moving to 24.04 raises the AppImage glibc floor — a conscious
  future decision, flagged in the workflow comment.
- **Two-platform manifest doubles the half-clobbered-CDN window.** Tolerable at daily cadence;
  don't shorten the throttle without revisiting.
- **ChromeOS matches the Linux browser gate** and is offered an AppImage (Crostini may run it).
  Accepted for v1, commented.

---

## 8. Deferred (explicitly out of scope)

- **AUR / apt repo / COPR** — the eventual package-manager and break-glass channels for Linux.
  **Flatpak / Snap** — out of scope entirely (host-binary spawning and FUSE make them a poor fit).
- **deb/rpm bundles** — optional later; the `APPIMAGE` gate already suppresses the updater in
  them. Revisit `mainBinaryName` then (deb/rpm claim `/usr/bin/<name>`).
- **linux-aarch64** — purely additive fast-follow: one matrix include on `ubuntu-22.04-arm`, one
  `PLATFORM_ASSETS` entry, one fetch slug already landed. Clients on a manifest without the key
  simply see "no update".
- **daemon-e2e-vs-rust Linux leg** — needs a per-OS parity allowlist.
- **External-browser preview TLS trust** (`~/.pki/nssdb` would fix Chromium only) — "open preview
  in browser" shows a warning for now.
- **Linux `install.sh`** — AppImage users don't need it.
- **gnome-keyring-backed CI for the keychain token-store e2e** — follows the Linux secret-store work.
- **Release-feed announcement** — belongs to the Linux launch, not this port.
