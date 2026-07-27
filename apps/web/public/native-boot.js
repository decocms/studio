// Dark-mode-before-first-paint for the Tauri (native) shell — the SAME
// localStorage-only mechanism as the inline script in `index.html`, but kept
// EXTERNAL (loaded via `<script src>`, not inline) so the shell's strict
// `script-src 'self'` CSP (`apps/native/src-tauri/tauri.conf.json5`) allows
// it. Tauri does NOT hash a page's inline scripts, so an inline `<script>`
// here is blocked outright (`securitypolicyviolation: script-src-elem blocked
// inline`); a same-origin external file is `'self'` and runs fine. Loaded as
// a render-blocking classic script in `<head>`, so it still runs before first
// paint — no flash. No network, works pre-sign-in.
(function () {
  try {
    var p = JSON.parse(localStorage.getItem("mesh:user:preferences") || "{}");
    var theme = p.theme || "system";
    var isDark =
      theme === "dark" ||
      (theme === "system" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    if (isDark) document.documentElement.classList.add("dark");
  } catch {}
})();
