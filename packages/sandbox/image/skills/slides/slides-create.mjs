/**
 * slides-create — compose a presentation deck from slide templates + data.
 *
 *   slides-create --data <json|@deck.json> --output <file>
 *     [--theme <name>] [--templates-dir <dir>] [-f]
 *
 * The data describes the deck declaratively; each slide names a layout
 * template and the values to fill in:
 *
 *   {
 *     "title": "Q3 Launch",
 *     "theme": "ink-dark",
 *     "slides": [
 *       { "template": "title",   "data": { "heading": "Q3 Launch" } },
 *       { "template": "bullets", "data": { "heading": "Goals", "items": ["…"] } }
 *     ]
 *   }
 *
 * Slide templates are resolved from --templates-dir first (org-specific
 * brand templates), then from this skill's slide-templates/ directory.
 * The rendered deck is a single self-contained HTML file driven by
 * Studio's /deck-runtime/v1/deck-viewer.js.
 *
 * Built on the `templating` skill's mustache engine — see
 * org/public/core/templating/SKILL.md for the template syntax.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Mustache from "../templating/vendor/mustache.mjs";

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));
const THEMES_DIR = join(SKILL_DIR, "themes");
const SLIDE_TEMPLATES_DIR = join(SKILL_DIR, "slide-templates");
const DEFAULT_THEME = "aurora-light";

function fail(message) {
  console.error(`slides-create: ${message}`);
  process.exit(1);
}

function usage() {
  console.error(
    [
      "Usage: slides-create --data <json|@deck.json> --output <file>",
      "         [--theme <name>] [--templates-dir <dir>] [-f]",
      "",
      "  --data           Deck description: inline JSON or @path/to/deck.json",
      "  --output         Path to write the deck HTML (e.g. org/home/decks/launch.html)",
      "  --theme          Built-in theme name OR path to a custom theme .html",
      '                   (overrides the data\'s "theme" field)',
      "  --templates-dir  Extra directory to resolve slide templates from (checked first)",
      "  -f               Overwrite the output file if it exists",
      "",
      `Themes: ${listNames(THEMES_DIR).join(", ")}`,
      `Slide templates: ${listNames(SLIDE_TEMPLATES_DIR).join(", ")}`,
    ].join("\n"),
  );
  process.exit(1);
}

function listNames(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".html"))
      .map((f) => f.replace(/\.html$/, ""))
      .sort();
  } catch {
    return [];
  }
}

function parseArgs(argv) {
  const args = { force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--data") args.data = argv[++i];
    else if (a === "--output") args.output = argv[++i];
    else if (a === "--theme") args.theme = argv[++i];
    else if (a === "--templates-dir") args.templatesDir = argv[++i];
    else if (a === "-f" || a === "--force") args.force = true;
    else if (a === "-h" || a === "--help") usage();
    else fail(`unknown argument: ${a} (try --help)`);
  }
  return args;
}

function loadDeckData(raw) {
  let text = raw;
  if (raw.startsWith("@")) {
    const file = raw.slice(1);
    if (!existsSync(file)) fail(`data file not found: ${file}`);
    text = readFileSync(file, "utf8");
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    fail(`--data is not valid JSON: ${err.message}`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    fail("--data must be a JSON object");
  }
  if (typeof data.title !== "string" || data.title.length === 0) {
    fail('deck data needs a "title" string');
  }
  if (!Array.isArray(data.slides) || data.slides.length === 0) {
    fail('deck data needs a non-empty "slides" array');
  }
  data.slides.forEach((slide, i) => {
    if (
      slide === null ||
      typeof slide !== "object" ||
      typeof slide.template !== "string"
    ) {
      fail(`slides[${i}] needs a "template" name`);
    }
    if (
      slide.data !== undefined &&
      (slide.data === null || typeof slide.data !== "object")
    ) {
      fail(`slides[${i}].data must be an object`);
    }
  });
  return data;
}

function resolveSlideTemplate(name, templatesDir) {
  if (!/^[\w-]+$/.test(name)) fail(`invalid slide template name: ${name}`);
  const candidates = [];
  if (templatesDir) candidates.push(join(templatesDir, `${name}.html`));
  candidates.push(join(SLIDE_TEMPLATES_DIR, `${name}.html`));
  for (const file of candidates) {
    if (existsSync(file)) return readFileSync(file, "utf8");
  }
  const known = listNames(SLIDE_TEMPLATES_DIR);
  fail(
    `unknown slide template "${name}". Built-in templates: ${known.join(", ")}` +
      (templatesDir ? ` (also searched ${templatesDir})` : ""),
  );
}

/**
 * `--theme` (or the data's "theme" field) accepts either a built-in name
 * (`ink-dark`) or a path to a custom theme shell file — a complete deck
 * HTML with a `{{{slides}}}` insertion point. Org brand themes live in
 * org-fs (e.g. `org/home/templates/slides/brand-theme.html`) and inject
 * the same way slide templates do via --templates-dir.
 */
function resolveThemePath(value) {
  if (value.includes("/") || value.toLowerCase().endsWith(".html")) {
    const file = resolve(value);
    if (!existsSync(file)) fail(`theme file not found: ${value}`);
    return file;
  }
  const file = join(THEMES_DIR, `${value}.html`);
  if (!/^[\w-]+$/.test(value) || !existsSync(file)) {
    fail(
      `unknown theme "${value}". Built-in themes: ${listNames(THEMES_DIR).join(", ")} ` +
        "(or pass a path to a custom theme .html)",
    );
  }
  return file;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.data || !args.output) usage();

  const deck = loadDeckData(args.data);
  if (deck.theme !== undefined && typeof deck.theme !== "string") {
    fail('deck data "theme" must be a string');
  }
  const themePath = resolveThemePath(args.theme || deck.theme || DEFAULT_THEME);

  const templatesDir = args.templatesDir
    ? resolve(args.templatesDir)
    : undefined;
  if (templatesDir && !existsSync(templatesDir)) {
    fail(`templates dir not found: ${args.templatesDir}`);
  }

  const sections = deck.slides.map((slide) => {
    const template = resolveSlideTemplate(slide.template, templatesDir);
    return Mustache.render(template, slide.data ?? {}).trim();
  });

  const outputPath = resolve(args.output);
  if (existsSync(outputPath) && !args.force) {
    fail(`output already exists: ${args.output} (pass -f to overwrite)`);
  }

  const theme = readFileSync(themePath, "utf8");
  const slidesHtml = sections.join("\n\n");
  // A theme is either a Mustache shell with a `{{{slides}}}` slot, or a
  // "deck-as-theme": a complete deck whose <deck-viewer> body is example
  // slides. For the latter, fill {{title}} then swap the deck-viewer body for
  // the rendered sections — so the same file is both an editable sample deck
  // and the generation shell (brand themes can be edited like any deck).
  let html;
  if (theme.includes("{{{slides}}}")) {
    html = Mustache.render(theme, { title: deck.title, slides: slidesHtml });
  } else {
    const titled = Mustache.render(theme, { title: deck.title });
    // Match the real `<deck-viewer width=… height=…>` element by requiring a
    // whitespace-led attribute after the tag name. Without the `\s`, the regex
    // also matches the bare `<deck-viewer>` mention inside the head authoring
    // comment that every generated deck ships, swallowing the <style>/<head>
    // and stripping all theme CSS from the output.
    html = titled.replace(
      /(<deck-viewer\s[^>]*>)[\s\S]*?(<\/deck-viewer>)/i,
      (_m, open, close) => `${open}\n${slidesHtml}\n${close}`,
    );
    if (html === titled) {
      fail(
        "theme has neither a {{{slides}}} slot nor a <deck-viewer> to fill — " +
          "pass a built-in theme, a shell with {{{slides}}}, or a deck file",
      );
    }
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, html);
  console.log(outputPath);
}

main();
