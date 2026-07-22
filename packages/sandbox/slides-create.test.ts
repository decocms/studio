import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(
  new URL("./image/skills/slides/slides-create.mjs", import.meta.url),
);

// A "deck-as-theme": a complete deck whose <deck-viewer> body is example
// slides. Note the head authoring comment mentions a bare `<deck-viewer>` —
// exactly what every generated deck ships, and what used to break the swap.
const DECK_AS_THEME = `<!DOCTYPE html>
<html>
<head>
<!--
  Studio deck (deck-viewer v1). Authoring rules:
  - Slides are the direct <section> children of <deck-viewer>; the canvas
-->
<style>--deck-accent: #0af; .deck-h1 { color: var(--deck-accent); }</style>
</head>
<body>
<deck-viewer width="1920" height="1080">
<section><h1 class="deck-h1">Example</h1></section>
</deck-viewer>
<script src="/deck-runtime/v1/deck-viewer.js"></script>
</body>
</html>`;

const DECK_DATA = JSON.stringify({
  title: "Generated",
  slides: [{ template: "title", data: { heading: "New Deck" } }],
});

function run(dir: string) {
  const themePath = join(dir, "theme.html");
  const dataPath = join(dir, "deck.json");
  const outPath = join(dir, "out.html");
  writeFileSync(themePath, DECK_AS_THEME);
  writeFileSync(dataPath, DECK_DATA);
  const res = Bun.spawnSync([
    "bun",
    CLI,
    "--data",
    `@${dataPath}`,
    "--theme",
    themePath,
    "--output",
    outPath,
  ]);
  if (res.exitCode !== 0) {
    throw new Error(`slides-create failed: ${res.stderr.toString()}`);
  }
  return readFileSync(outPath, "utf8");
}

describe("slides-create deck-as-theme", () => {
  it("preserves the theme <style> and canvas when swapping slides", () => {
    const html = run(mkdtempSync(join(tmpdir(), "slides-")));
    // The head <style> (theme CSS) must survive — the bug stripped it because
    // the swap regex matched the `<deck-viewer>` inside the head comment.
    expect(html).toContain("--deck-accent: #0af");
    // The real 1920×1080 canvas element must survive too.
    expect(html).toContain('<deck-viewer width="1920" height="1080">');
    // The generated slide replaced the theme's example slide.
    expect(html).toContain("New Deck");
    expect(html).not.toContain(">Example<");
  });
});
