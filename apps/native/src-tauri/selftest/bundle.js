// DESKTOP_SELFTEST=1 runtime validation bundle.
//
// `eval()`'d into the shell's window once its page has finished loading
// (see `src/setup.rs`), NOT part of the shipped frontend — this file only
// ever runs under `DESKTOP_SELFTEST=1` (see `src/selftest.rs`). It
// validates, against the REAL running local-api server through the REAL
// WKWebView:
//
//   (a) `invoke('local_api_info')` returns the fixed self-test control port,
//       preview port, upstream origin, and a one-time bootstrap capability.
//       The page itself and every control request share
//       `http://localhost:43122`.
//   (b) Cookie auth: an explicit credential-less session probe is 401, while
//       the normal credentialed probe is already 204. The latter proves the
//       real native entry exchanged its one-time IPC capability before React
//       mounted. Replaying that capability is rejected, and `/_sandbox/tasks`
//       succeeds with browser credentials and no `Authorization` header.
//   (c) Native `EventSource` receives the initial sandbox `status` event.
//       EventSource cannot carry a custom Authorization header, so this is a
//       direct browser-level proof that the HttpOnly cookie authenticates SSE.
//   (d) Both control and preview use plain `localhost` on separate ports. A
//       real credentialed request to the preview listener stores and replays
//       a `SameSite=Strict; HttpOnly` sandbox cookie in WKWebView, then the
//       control session still succeeds with that unrelated cookie present.
//       The control cookie itself remains invisible to `document.cookie`.
//   (e) CSP `img-src` widening (real-UI course-correction, `tauri.conf.
//       json5` + `src/csp.rs`): loads a real remote `https:` `<img>` (the
//       exact Google login-icon URL) and asserts it loads, PLUS asserts
//       `__BOOT_ERRORS` recorded zero `securitypolicyviolation` events
//       across the whole boot (`setup.rs`'s captor script). The remote image
//       load is REPORTED but NOT gating — it is network-dependent, so a
//       runner without egress fails it for reasons unrelated to the app. The
//       CSP property it protects is gated by `noCspViolations` instead: a CSP
//       block raises a `securitypolicyviolation`, an unreachable CDN does not.
//   (f) Port-router split (`local_api::ServerHandle`'s main/preview
//       listeners): `local_api_info()` returns a `previewPort` alongside
//       `port`, and a real `<iframe>` pointed at
//       `http://localhost:<previewPort>/` actually loads — proving BOTH
//       that the dedicated preview listener answers and that `frame-src`
//       isn't blocking it. Two credentialed fetches then prove both
//       `connect-src` and the strict-cookie round trip.
//
// Reports via `invoke('selftest_report', { report: { results, allPass } })`,
// which writes `DESKTOP_SELFTEST_OUT` and exits the app (0 if `allPass`,
// else 1) — see `src/commands.rs`.
//
// Retry note: empirically (see the native implementation contract's "Runtime
// validation" section), the VERY FIRST `fetch()` this webview ever makes to
// a given origin can fail once with a generic "Load failed" network error
// even though the server is up and every subsequent request to that same
// origin succeeds immediately — a WKWebView connection-establishment
// artifact, not a local-api bug (confirmed by curling the same route
// successfully outside the webview in the same run). `fetchNetworkRetry`
// below retries ONLY on a `fetch()`-level rejection (a network error) — an
// actual non-2xx HTTP response is never retried, since that's a real
// assertion outcome, not a transient hiccup. This file has no bundler/
// import available (a raw `eval()`'d script, not part of this repo's
// TS build) — @decocms/shared/std's `retry` isn't reachable here, hence the small
// hand-rolled loop; that package's "don't hand-roll retry" rule targets the
// TS/Rust codebases it's published into, not a standalone browser script.
(async () => {
  const results = {};
  const deadlineFor = (ms) => Date.now() + ms;
  // The shipped app supports macOS 11, whose WKWebView predates
  // AbortSignal.timeout. This raw self-test bundle has no module imports, so
  // keep its compatibility boundary local.
  const timeoutSignal = (ms) => {
    if (typeof AbortSignal.timeout === "function") {
      return AbortSignal.timeout(ms);
    }
    const controller = new AbortController();
    window.setTimeout(() => controller.abort(), ms);
    return controller.signal;
  };

  async function fetchNetworkRetry(url, opts, attempts = 3, delayMs = 200) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        // Per-attempt deadline: a hanging network request must fail the
        // attempt, not wedge the whole selftest with no report.
        const withDeadline = { signal: timeoutSignal(8000), ...opts };
        return { res: await fetch(url, withDeadline), attempts: i + 1 };
      } catch (e) {
        lastErr = e;
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw Object.assign(lastErr, { attempts });
  }

  async function waitForTauriGlobal(timeoutMs) {
    const deadline = deadlineFor(timeoutMs);
    while (Date.now() < deadline) {
      if (window.__TAURI__ && window.__TAURI__.core) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  }

  async function finish(allPass) {
    const report = { results, allPass };
    try {
      await window.__TAURI__.core.invoke("selftest_report", { report });
    } catch (e) {
      // If even the report call fails, there is nothing left this script
      // can do to signal the harness — the boot-smoke script's own
      // deadline (it kills the process and fails) is the backstop.
      console.error("[selftest] failed to report results:", e);
    }
  }

  const gotGlobal = await waitForTauriGlobal(5000);
  if (!gotGlobal) {
    results.fatalError = "window.__TAURI__ never became available";
    await finish(false);
    return;
  }

  const invoke = window.__TAURI__.core.invoke;

  let info;
  try {
    info = await invoke("local_api_info");
    results.localApiInfo = {
      ok:
        info.port === 43122 &&
        typeof info.previewPort === "number" &&
        typeof info.upstreamUrl === "string" &&
        info.upstreamUrl.length > 0 &&
        typeof info.token === "string" &&
        info.token.length > 0,
      value: {
        port: info.port,
        previewPort: info.previewPort,
        upstreamUrl: info.upstreamUrl,
      },
    };
  } catch (e) {
    results.localApiInfo = { ok: false, error: String(e) };
    await finish(false);
    return;
  }

  const base = `http://localhost:${info.port}`;
  const previewBase = `http://localhost:${info.previewPort}`;
  const previewUrl = new URL(previewBase);
  results.sameOriginControl = {
    ok:
      window.location.origin === base &&
      window.location.hostname === "localhost",
    pageOrigin: window.location.origin,
    expectedOrigin: base,
  };
  results.controlCookieHttpOnly = {
    ok:
      window.location.hostname === "localhost" &&
      previewUrl.hostname === "localhost" &&
      !document.cookie
        .split(";")
        .map((part) => part.trim().split("=")[0])
        .includes("decocms-local-session"),
    controlHostname: window.location.hostname,
    previewHostname: previewUrl.hostname,
    controlCookieVisibleToScript: document.cookie
      .split(";")
      .map((part) => part.trim().split("=")[0])
      .includes("decocms-local-session"),
  };

  // The native entry owns the one-time bootstrap and runs before React
  // mounts. PageLoadEvent::Finished can race its promise by a few
  // milliseconds, so wait for the normal credentialed probe to become 204
  // instead of trying to consume the same one-time capability here.
  async function waitForFrontendSession(timeoutMs) {
    const deadline = deadlineFor(timeoutMs);
    let attempts = 0;
    let status = 0;
    while (Date.now() < deadline) {
      attempts++;
      const probe = await fetch("/_local/session", {
        credentials: "include",
        cache: "no-store",
      });
      status = probe.status;
      if (status === 204 || status !== 401) {
        return { status, attempts };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { status, attempts };
  }

  // --- (a) same-origin Strict-cookie auth -----------------------------
  try {
    const { res, attempts } = await fetchNetworkRetry("/health", {
      credentials: "omit",
      cache: "no-store",
    });
    results.health200Public = {
      ok: res.status === 200,
      status: res.status,
      attempts,
    };
  } catch (e) {
    results.health200Public = {
      ok: false,
      error: String(e),
      attempts: e.attempts,
    };
  }

  try {
    const { res, attempts } = await fetchNetworkRetry("/_local/session", {
      credentials: "omit",
      cache: "no-store",
    });
    results.session401WithoutCookie = {
      ok: res.status === 401,
      status: res.status,
      attempts,
    };
  } catch (e) {
    results.session401WithoutCookie = {
      ok: false,
      error: String(e),
      attempts: e.attempts,
    };
  }

  try {
    const established = await waitForFrontendSession(5000);
    results.session204WithCookie = {
      ok: established.status === 204,
      status: established.status,
      attempts: established.attempts,
    };
  } catch (e) {
    results.session204WithCookie = { ok: false, error: String(e) };
  }

  // The real frontend consumed this capability to establish the cookie.
  // Replaying it must fail, even though the request's Origin is the exact
  // control origin. `credentials: "omit"` makes the assertion independent
  // of the now-valid session cookie.
  try {
    const res = await fetch("/_local/session/bootstrap", {
      method: "POST",
      credentials: "omit",
      headers: { Authorization: `Bearer ${info.token}` },
      signal: timeoutSignal(8000),
    });
    results.bootstrapSecretOneTime = {
      ok: res.status === 401,
      status: res.status,
    };
  } catch (e) {
    results.bootstrapSecretOneTime = {
      ok: false,
      error: String(e),
    };
  }

  try {
    const { res, attempts } = await fetchNetworkRetry("/_sandbox/tasks", {
      credentials: "include",
      cache: "no-store",
    });
    results.protectedRoute200WithCookie = {
      ok: res.status === 200,
      status: res.status,
      attempts,
    };
  } catch (e) {
    results.protectedRoute200WithCookie = {
      ok: false,
      error: String(e),
      attempts: e.attempts,
    };
  }

  // A credential-less unsafe request must be rejected before its handler
  // mutates the isolated self-test workdir. Verify both the 401 and the
  // file's continued absence through an authenticated read.
  const unauthorizedMutationPath = "selftest-unauthorized-mutation.txt";
  try {
    const write = await fetch("/_sandbox/write", {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: unauthorizedMutationPath,
        content: "this write must never happen",
      }),
    });
    const verification = await fetch("/_sandbox/read", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: unauthorizedMutationPath }),
    });
    results.credentiallessMutationRejected = {
      ok: write.status === 401 && verification.status === 400,
      writeStatus: write.status,
      verificationStatus: verification.status,
    };
  } catch (e) {
    results.credentiallessMutationRejected = {
      ok: false,
      error: String(e),
    };
  }

  // Hang forensics: after authentication, persist partial results through
  // the local API's fs/write using the native cookie. No bearer header is
  // attached. Best-effort: forensics must never decide the run.
  async function progress(label) {
    try {
      await fetch("/_sandbox/write", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          path: "selftest-progress.json",
          content: JSON.stringify({ at: label, results }, null, 2),
        }),
      });
    } catch {
      /* forensics must never break the run */
    }
  }
  await progress("localApiInfo");

  // DOM probe early because it is the most useful hang forensic if a later
  // browser-level check wedges.
  try {
    await new Promise((r) => setTimeout(r, 6000));
    const root = document.getElementById("root");
    const rootLength = root ? root.innerHTML.length : -1;
    results.domMountedEarly = {
      ok: rootLength > 0,
      rootLength,
      bodyText: (document.body.innerText || "").slice(0, 300),
      bootErrors: (window.__BOOT_ERRORS || []).slice(0, 10),
    };
  } catch (e) {
    results.domMountedEarly = { ok: false, error: String(e) };
  }
  await progress("domMountedEarly");

  // --- (b) cookie-authenticated native EventSource -------------------
  results.eventSourceStatusEvent = await new Promise((resolve) => {
    const source = new EventSource("/_sandbox/events");
    let settled = false;
    const finishEvent = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      source.close();
      resolve(result);
    };
    const timer = setTimeout(
      () => finishEvent({ ok: false, error: "timeout" }),
      5000,
    );
    source.addEventListener("status", (event) => {
      finishEvent({
        ok: true,
        eventType: event.type,
        data: String(event.data).slice(0, 300),
      });
    });
    source.onerror = () => {
      finishEvent({
        ok: false,
        error: `EventSource error (readyState=${source.readyState})`,
      });
    };
  });
  await progress("eventSourceStatusEvent");

  // --- auth_status invoke sanity (informational) ----------------------
  try {
    const status = await invoke("auth_status");
    results.authStatusInvoke = {
      ok:
        typeof status.signedIn === "boolean" &&
        typeof status.upstreamUrl === "string",
      value: status,
    };
  } catch (e) {
    results.authStatusInvoke = { ok: false, error: String(e) };
  }

  // --- CSP: remote https <img> load (real-UI course-correction) -------
  // `img-src` was widened (`tauri.conf.json5`) to allow `https:`/`blob:` in
  // addition to `'self'` so provider-login icons and org/user avatars
  // render — see `src/csp.rs`'s module doc. Unlike `connect-src`, a
  // `fetch()` call does NOT exercise `img-src` at all, so the only way to
  // observe an `img-src` CSP block empirically is a real `<img>` element
  // load — this loads the EXACT Google login-icon URL the real shell
  // renders (`apps/api/src/auth/oauth-providers.ts`).
  async function probeRemoteImage(url, timeoutMs = 8000) {
    return new Promise((resolve) => {
      const img = new Image();
      const timer = setTimeout(
        () => resolve({ ok: false, error: "timeout" }),
        timeoutMs,
      );
      img.onload = () => {
        clearTimeout(timer);
        resolve({
          ok: true,
          width: img.naturalWidth,
          height: img.naturalHeight,
        });
      };
      img.onerror = () => {
        clearTimeout(timer);
        resolve({
          ok: false,
          error: "onerror (blocked by CSP, or unreachable)",
        });
      };
      img.src = url;
    });
  }
  results.remoteImageLoads = await probeRemoteImage(
    "https://assets.decocache.com/webdraw/eb7480aa-a68b-4ce4-98ff-36aa121762a7/google.svg",
  );
  await progress("remoteImageLoads");

  // --- Preview port: frame-src CSP allows a real iframe load -----------
  // Verifies BOTH halves of the port-router split empirically, in the REAL
  // WKWebView: (1) the dedicated preview listener is up and unauthenticated
  // (an `onload` firing at all proves the TCP listener accepted the
  // connection and answered — even the 503 "no dev server running"
  // placeholder page counts, since no dev server is running in this
  // self-test harness), and (2) `frame-src` was actually widened for this
  // origin — a misconfigured CSP would instead silently block the
  // navigation (no `onload`) and record a `securitypolicyviolation` the
  // `noCspViolations` gate below would also independently catch. Unlike
  // the main port (exercised via plain `fetch()` above), the preview port
  // is deliberately probed via a real `<iframe>`, matching production.
  async function probePreviewIframe(url, expectedOrigin, timeoutMs = 8000) {
    return new Promise((resolve) => {
      const iframe = document.createElement("iframe");
      iframe.style.display = "none";
      let settled = false;
      const cleanup = () => {
        window.removeEventListener("message", onMessage);
        iframe.remove();
      };
      const onMessage = (event) => {
        if (
          settled ||
          event.source !== iframe.contentWindow ||
          event.origin !== expectedOrigin ||
          event.data?.type !== "decocms-preview-selftest-ready"
        ) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve({ ok: true, origin: event.origin });
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ ok: false, error: "timeout" });
      }, timeoutMs);
      iframe.onerror = (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve({ ok: false, error: String(e) });
      };
      window.addEventListener("message", onMessage);
      iframe.src = url;
      document.body.appendChild(iframe);
    });
  }
  const previewCookieUrl = `http://localhost:${info.previewPort}/_local/selftest/preview-cookie`;
  results.previewIframeLoads = await probePreviewIframe(
    `http://localhost:${info.previewPort}/_local/selftest/preview-frame`,
    previewUrl.origin,
  );
  await progress("previewIframeLoads");

  try {
    const { res: first, attempts: firstAttempts } = await fetchNetworkRetry(
      previewCookieUrl,
      {
        cache: "no-store",
        credentials: "include",
      },
    );
    const firstPayload = await first.json();
    const { res: second, attempts: secondAttempts } = await fetchNetworkRetry(
      previewCookieUrl,
      {
        cache: "no-store",
        credentials: "include",
      },
    );
    const secondPayload = await second.json();
    const controlProbe = await fetch("/_local/session", {
      credentials: "include",
      cache: "no-store",
    });
    results.previewCookieRoundTrip = {
      ok:
        first.ok &&
        firstPayload.received === false &&
        second.ok &&
        secondPayload.received === true &&
        controlProbe.status === 204,
      firstStatus: first.status,
      firstReceived: firstPayload.received,
      secondStatus: second.status,
      secondReceived: secondPayload.received,
      controlStatusWithPreviewCookie: controlProbe.status,
      firstAttempts,
      secondAttempts,
    };
  } catch (e) {
    results.previewCookieRoundTrip = { ok: false, error: String(e) };
  }
  await progress("previewCookieRoundTrip");

  /**
   * Monaco: the code editor engine this shell asks for is one it can load.
   *
   * The engine is not part of the JS bundle — it is ~100 files under
   * `/monaco/<version>/vs` (`apps/web/vite.config.ts`'s `self-hosted-monaco`),
   * fetched at runtime by a `<script>` and, for the language services, a
   * `Worker`. The app shipped a CDN path for months and every code surface
   * rendered a permanent spinner, because `script-src 'self'` refused the
   * engine while the file contents themselves loaded fine — green everywhere
   * else, unusable here.
   *
   * Asserts the two facts that turn that bug into a red build, both cheap and
   * deterministic: the path THIS APP declares (read back from
   * `MonacoEnvironment`, which `apps/web/src/index.native.tsx` sets at boot)
   * is same-origin, and the engine actually answers on it. An off-origin path
   * fails the first; files that never shipped fail the second.
   *
   * Deliberately does NOT load the engine (3.7 MB) or start a language worker
   * (5.5 MB): this self-test shares ONE 60 s process budget with every other
   * check here, and a slow probe would fail them all rather than itself. That
   * the engine runs under the packaged CSP is asserted in a browser against
   * this exact policy, and its assets are covered by
   * `packages/e2e/tests/monaco-engine-assets.spec.ts`.
   */
  async function probeMonacoEngine() {
    const getWorkerUrl = window.MonacoEnvironment?.getWorkerUrl;
    if (typeof getWorkerUrl !== "function") {
      return { ok: false, stage: "app-declared-no-worker-url" };
    }
    const workerUrl = getWorkerUrl("workerMain.js", "typescript");
    const suffix = "/base/worker/workerMain.js";
    if (typeof workerUrl !== "string" || !workerUrl.endsWith(suffix)) {
      return { ok: false, stage: "unexpected-worker-url", workerUrl };
    }
    // Same-origin means `script-src 'self'` permits it; a CDN URL is the
    // regression, and `new URL` resolves a relative path against this page.
    const vs = workerUrl.slice(0, -suffix.length);
    if (new URL(vs, window.location.href).origin !== window.location.origin) {
      return { ok: false, stage: "engine-path-is-off-origin", vs };
    }

    try {
      const { res } = await fetchNetworkRetry(`${vs}/loader.js`, {
        credentials: "include",
      });
      const contentType = res.headers.get("content-type") || "";
      return {
        ok: res.status === 200 && contentType.includes("javascript"),
        stage: "engine-served",
        vs,
        status: res.status,
        contentType,
      };
    } catch (e) {
      return { ok: false, stage: "engine-fetch-failed", vs, error: String(e) };
    }
  }
  try {
    results.monacoEngineBoots = await probeMonacoEngine();
  } catch (e) {
    results.monacoEngineBoots = { ok: false, error: String(e) };
  }
  await progress("monacoEngineBoots");

  // --- CSP: zero violations captured by `setup.rs`'s boot-error captor -
  // `securitypolicyviolation` frames (see `setup.rs`'s initialization
  // script) land in `__BOOT_ERRORS` alongside `error`/`unhandledrejection`
  // — this asserts none were recorded across the ENTIRE boot so far (not
  // just the image probe above), catching a regression in ANY directive
  // (connect-src, script-src, style-src), not only img-src.
  //
  const cspViolations = (window.__BOOT_ERRORS || []).filter((e) =>
    e.startsWith("securitypolicyviolation:"),
  );
  results.noCspViolations = {
    ok: cspViolations.length === 0,
    violations: cspViolations,
  };

  // Informational DOM probe — NOT part of `allPass`. The self-test window
  // loads the real frontend, so this reports what the app actually
  // rendered: a zero `rootLength` means the React tree never mounted (the
  // blank-screen class of regression), while `bodyText` distinguishes an
  // error card / spinner / sign-in screen. Waits a few seconds so the auth
  // gate + config fetch have a chance to settle either way.
  try {
    await new Promise((r) => setTimeout(r, 6000));
    const root = document.getElementById("root");
    results.domMounted = {
      ok: true,
      info: true,
      rootLength: root ? root.innerHTML.length : -1,
      bodyText: (document.body.innerText || "").slice(0, 400),
      bootErrors: (window.__BOOT_ERRORS || []).slice(0, 10),
      scripts: performance
        .getEntriesByType("resource")
        .filter((r) => r.initiatorType === "script" || r.name.endsWith(".js"))
        .map((r) => `${r.name.split("/").pop()} transfer=${r.transferSize}`),
    };
  } catch (e) {
    results.domMounted = { ok: true, info: true, error: String(e) };
  }

  const gating = [
    results.localApiInfo,
    results.sameOriginControl,
    results.health200Public,
    results.session401WithoutCookie,
    results.session204WithCookie,
    results.bootstrapSecretOneTime,
    results.protectedRoute200WithCookie,
    results.credentiallessMutationRejected,
    results.eventSourceStatusEvent,
    results.controlCookieHttpOnly,
    results.authStatusInvoke,
    results.domMountedEarly,
    // remoteImageLoads is deliberately NOT gating: it fetches a real asset
    // over the public internet, so a runner with no egress fails it for
    // reasons that say nothing about this app. The property it exists to
    // protect — that the packaged CSP does not block remote images — is
    // still gated, by noCspViolations below: a CSP block raises a
    // securitypolicyviolation, whereas an unreachable CDN does not. Its
    // result is still reported, so a real regression is visible.
    results.previewIframeLoads,
    results.previewCookieRoundTrip,
    results.monacoEngineBoots,
    results.noCspViolations,
  ];
  const allPass = gating.every((r) => r && r.ok === true);

  await finish(allPass);
})();
