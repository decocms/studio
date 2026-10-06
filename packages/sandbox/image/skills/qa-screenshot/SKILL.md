---
name: qa-screenshot
description: Screenshot a page (deploy preview or a dev server on localhost) in the sandbox's headless Chromium, look at it, and embed it in a task comment. Use to verify a visual change or record before/after evidence.
---

# qa-screenshot — see the change, then show it

A browser is installed globally in the sandbox, NOT in the repo's
`node_modules` — don't go looking for playwright there.

## Capture

```
qa-screenshot <url> /app/org/output/qa/<name>.png [--mobile] [--full] [--selector=<css>] [--console]
```

- Renders any URL, localhost included, in headless Chromium and runs the page's JS.
- Framing: default is the top viewport, `--full` the whole page, `--selector='<css>'` just the component you changed (best for a focused before/after).
- `--mobile` is a real phone viewport AND a mobile user-agent, not a narrowed desktop. Capture both desktop and mobile for a responsive change.
- `--console` also reports the page's runtime errors, which a screenshot alone shows as a pass.
- Deep-link to the page the change affects, not the site root.
- No dev server runs by default. Start one yourself to capture localhost.
- `--engine=webkit` renders in WebKit (Safari's engine) — use it when a mobile scroll, snap or animation quirk could be engine-specific, or when asked to check Safari. It is not a real iPhone or Mac: report it as "checked in WebKit", not as tested on iOS or Safari.

## Look at it

`Read` every file you wrote. A screenshot you never opened is not verification.

## Show it

Write under `/app/org/output/` and embed the shots in your task comment as markdown
images. Only that form renders on the card; a bare path or a code span shows
the reader nothing. Put a before/after pair in a two-column table so they
render side by side:

```
| Before | After |
| --- | --- |
| ![before desktop](/app/org/output/qa/before-desktop.png) | ![after desktop](/app/org/output/qa/after-desktop.png) |
```

## Interact

To click, fill a form or hit-test with `document.elementFromPoint`, write a
throwaway node script against the global playwright-core:

```js
const { chromium } = require("/usr/local/lib/node_modules/playwright-core");
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
```

For WebKit, use `webkit` from the same playwright-core with
`browser.newContext(devices["iPhone 13"])`.

Don't report a check as impossible because Playwright is missing — it is installed.
