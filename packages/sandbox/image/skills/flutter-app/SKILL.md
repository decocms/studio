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

## First: check which sandbox image you are on

If `qa-app` is on your `PATH` (equivalently, `$STUDIO_SANDBOX_FLUTTER_DESKTOP`
is set), this repo opted into the **Flutter sandbox image** and you can run the
app for real — see [Running the real app](#running-the-real-app-qa-app), which
is strictly better than the web build and is what you should reach for first.

Otherwise you are on the default image and the web build below is your only
way to see a UI. If the web build then fails for a reason you cannot fix (the
common one is a dependency that does not compile to JS — see [When the web
build fails](#when-the-web-build-fails)), say so in your report **and say that
the repo can be switched to the Flutter image in Settings → Repositories**.
That is the fix; do not spend the run working around it.

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

## Running the real app (`qa-app`)

Only on the Flutter sandbox image. This runs the app's actual `main()` on the
Linux desktop target — real routing, real state, real navigation — inside a
headless X server, and lets you click it and screenshot it.

Prefer it over the web build whenever it is available. It is a NATIVE target,
so the two things that most often kill `flutter build web` (64-bit integer
literals, `dart:html`) cannot happen, and you are looking at the whole app
rather than one widget.

```bash
qa-app start --size 390x844      # generates linux/ if absent; first build is slow
qa-app shot org/output/qa/01.png
qa-app click 346 800             # coordinates read off that screenshot
qa-app type "search term"
qa-app key Return
qa-app shot org/output/qa/02.png
qa-app logs 80                   # the app's stdout — where plugin errors land
qa-app stop
```

Then `Read` the PNGs. A screenshot you never opened is not verification.

**Read the coordinates off the screenshot.** There is no semantics tree to
consult and none is needed: the picture and the X display are the same pixels
at the same size, so a button's centre in the PNG is exactly what `qa-app
click` takes. (The web build needs `qa-screenshot --flutter` only because its
DOM is one opaque `<canvas>`.)

**`linux/` is generated, not yours.** If the repo targets only android/ios/web,
`qa-app start` runs `flutter create --platforms=linux .` and registers `linux/`
in `.git/info/exclude`, because the daemon checkpoints your working tree to the
branch every couple of minutes. Do not commit it, and do not "fix" its absence.

**The failure to expect is a plugin with no Linux implementation.** Those
compile fine and throw `MissingPluginException` or `PlatformException` on first
call — commonly Firebase, push, webview, biometrics. `qa-app logs` is where you
see it. If it throws during app startup the app never paints; report which
plugin and which screen you could not reach rather than approving blind. What
this is NOT: `MissingPlatformDirectoryException` from `path_provider`, which is
an environment problem, not a missing implementation — if you see it, say so,
because it means the image is missing `xdg-user-dirs` and that is a bug to
file, not to work around.

## Looking at the UI (web build)

On the default image this is the only option; on the Flutter image prefer
`qa-app` above.

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
- **A DEPENDENCY that cannot compile to JS.** Two signatures: "The integer
  literal 0x… can't be represented exactly in JavaScript" (dart2js) and
  "dart:html unsupported" (dart2wasm). Check the file path in the error — if it
  is under `.pub-cache`, it is a transitive dependency and it is **not yours to
  fix**. Neither is it worth retrying: `--release`, `--profile`, `--wasm` and
  `run -d web-server` all go through those same two compilers, so if one fails
  this way they all do. Stop, and report that the repo needs the Flutter
  sandbox image (Settings → Repositories), which has no such limit.

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
