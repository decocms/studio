---
name: flutter-app
description: Work on a Flutter/Dart repository (one with a pubspec.yaml) in the sandbox — resolve private pub dependencies, run analyze/test, and QA the UI by compiling to web and screenshotting it. Use whenever the repo you are working in is a Flutter app, and especially before reporting that you cannot see or exercise a mobile app's UI.
---

# flutter-app — building and QA'ing an app that is not a website

A Flutter repo breaks two assumptions the rest of the sandbox is built on: its
pull requests have no deploy `previewUrl`, and there is no emulator here (the
nodes have no `/dev/kvm`, and nothing is going to change that). So the usual
"open the preview and look at it" does not apply, and neither does giving up.

What you have instead: the Flutter SDK at `/opt/flutter` (already on `PATH`),
and the ability to compile the app **to web** and point a real browser at it.
That is how you look at the UI.

## Check the version pin first

`flutter analyze` produces different findings on different releases. Compare
the image's `flutter --version` against whatever the repo's CI pins (commonly
`FLUTTER_VERSION` in `.github/workflows/*.yml`, or `.fvmrc`). If they differ,
**say so in your report** and treat analyzer findings that the repo's own gate
would not produce as suspect. Do not "fix" them silently.

## Private dependencies

Most real apps pull packages from private git repos:

```yaml
dependencies:
  some_internal_lib:
    git:
      url: https://github.com/acme/internal-flutter-lib.git
      ref: v1.2.3
```

`flutter pub get` fetches those over plain HTTPS, and the sandbox is already set
up for it: the daemon installs the run's credentials in the pod's git config at
boot, so `flutter pub get` needs no preparation. Just run it.

> **Never run `gh auth setup-git` here.** The first thing it writes is an empty
> `credential.<url>.helper`, which git reads as "discard every helper configured
> earlier" — and because `GIT_CONFIG_GLOBAL` points at the daemon's config, that
> write lands in the same file and deletes the credentials the pod booted with.
> A `pub get` that worked will start 404ing.

What the credentials reach is decided before the run starts: Studio walks the
`git:` dependencies in `pubspec.yaml`, and the dependencies of those, and mints
the token for this repository plus **every same-owner repository in that graph**
(capped at 20), plus any **git credential** the organization configured for the
host. So a normal private dependency tree resolves, and three cases do not:

- **A repository outside the token and with no configured credential.** The
  minted token belongs to one GitHub App installation and covers only the
  repositories that installation was granted, so a dependency under a different
  owner — or one the installation was never given — is out of reach. The fix is
  not yours to apply: someone adds a git credential for that host in
  Settings → Repositories (a PAT stored as an org secret), and the next boot
  installs it for every git in the pod, `pub get` included. **Report that as
  the blocker and name the host**; do not go looking for a token yourself.
- **A private dependency added on your working branch.** The walk read each
  repository's default branch, so a `git:` dependency your PR introduces is not
  in the token. Say so in your report rather than working around it.
- **A repository the organization did not authorize for Studio.** The walk stops
  at the grant, by design.

So a 404 from `pub get` is one of those three — **report it**. Do not go looking
for another token, and never paste one into `pubspec.yaml`, a git URL, or a
config file.

`flutter pub get` on a cold sandbox takes a few minutes. Run it once.

## The checks

```bash
flutter analyze        # the repo's own gate, usually
flutter test           # unit + widget tests
```

Run these before you hand over. They are fast and they are what CI will say.

## Looking at the UI

```bash
flutter build web --release        # ~30s for a small app, minutes for a real one
(cd build/web && python3 -m http.server 8099 &)
until curl -sfo /dev/null http://localhost:8099; do sleep 0.3; done   # it binds after you ask
qa-screenshot http://localhost:8099 org/output/qa/after.png --mobile --flutter --console
```

Then `Read` the PNG. A screenshot you never opened is not verification.

`--flutter` matters. Flutter paints the whole app into a single `<canvas>`:
the DOM contains no text and no widgets, so without it you would be clicking
blind pixels. The flag turns on Flutter's accessibility tree, which
materializes one `<flt-semantics>` element per widget, and prints them:

```
flutter widgets (showing 4 of 4) — frame one with --label=<text>, click one by aiming mouse.click at its box centre:
        "Flutter Demo Home Page" @ 0,0 390x56
        "You have pushed the button this many times:" @ 50,422 289x20
        "0" @ 187,442 16x36
  [tap] "Increment" @ 318,772 56x56
```

That listing is your map of the screen. It is also an assertion target: if the
widget you just added is not in it, it did not render — but read the count
first. A busy screen prints only the first 60 and says so; `--label` still
matches against all of them, so ask for yours by name before concluding it is
missing.

Frame one widget for a focused before/after — the equivalent of `--selector`
on a web page:

```bash
qa-screenshot http://localhost:8099 org/output/qa/fab.png --flutter --label=Increment
```

Do NOT reach for `--selector` here. Flutter emits **no `aria-label`**, and
element ids are a per-build counter (`flt-semantic-node-8`), so there is no
stable CSS handle — the label is the handle. `--label` matches the exact text
first, then a unique case-insensitive substring, and tells you the candidates
if it is ambiguous.

To drive the app, aim the mouse at a box centre. A semantics node is a
transparent overlay, so `page.click(selector)` fails Playwright's visibility
checks — coordinates are the way in:

```js
const { chromium } = require("/usr/local/lib/node_modules/playwright-core");
const b = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
});
const p = await b.newPage({ viewport: { width: 390, height: 844 } });
await p.goto("http://localhost:8099", { waitUntil: "load" });
// Wait for the placeholder, don't sleep at it — a release build compiles wasm
// and loads fonts after `load`, and on a cold sandbox that outlasts any guess.
await p.waitForSelector("flt-semantics-placeholder", { state: "attached", timeout: 20000 });
// Building the semantics tree is opt-in; this click is the supported trigger.
await p.evaluate(() => document.querySelector("flt-semantics-placeholder")?.click());
await p.waitForFunction(() => document.querySelectorAll("flt-semantics").length > 0);
const box = await p.evaluate(() => {
  const el = Array.from(document.querySelectorAll("flt-semantics"))
    .filter((n) => !n.querySelector("flt-semantics"))
    .find((n) => (n.textContent || "").trim() === "Increment");
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await p.mouse.click(box.x, box.y);
```

Then re-read the semantics tree to assert what changed — it is the only
readable representation of app state a canvas app has.

One wrinkle when you re-read it in the same page: interacting with a widget can
add a SECOND node carrying the same label — a tapped `FloatingActionButton`
materializes its tooltip, so `"Increment"` appears twice from the first click
on. Match on the tappable node or the one whose box you clicked, not on "the
only node with this label". A fresh `qa-screenshot` run reloads the page, so
`--label` is unaffected.

### When the web build fails

It usually fails for one of two reasons, and both are worth reporting rather
than working around:

- **A bare `import 'dart:io'`.** Does not compile to web. `Platform.isAndroid`
  has a web-safe replacement in `defaultTargetPlatform`
  (`package:flutter/foundation.dart`); real file I/O needs a `kIsWeb` guard or
  a conditional import. These are small, genuine portability fixes — make them
  if they are in the code you are already touching, and mention them if not.
- **A plugin with no web implementation.** These compile fine and throw at
  runtime, so the app renders and then breaks on one call. `--console` is what
  catches it: a page that looks right and throws is the failure a screenshot
  alone reports as a pass. Screenshot the screens that do work, and say plainly
  which path you could not exercise.

If the app genuinely cannot reach web, fall back to the checks above plus
reading the code end to end — and **say what you could not see**, rather than
approving on the assumption it is fine.

## What golden tests are and are not

`flutter test --update-goldens` renders widgets to PNG with no browser and no
device, which sounds like the answer and is not: `flutter_test` draws with a
placeholder font, so every glyph comes out a black box. Goldens are a
**layout-regression diff between two runs**, not something you or a human can
look at and judge. Use the web build to SEE the UI. Use goldens only if the
repo already has them, or to prove a layout did not shift — and if you add
them, `golden_toolkit`'s `loadAppFonts()` is what makes the text legible.
