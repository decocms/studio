/**
 * create-from-template — render a mustache template file with JSON data.
 *
 *   create-from-template --template <file> --data <json|@file> --output <file>
 *     [--partials-dir <dir>] [--strict] [-f]
 *
 * Works for any text file (HTML, markdown, config, SQL, email, …).
 * Mustache semantics: {{var}} (HTML-escaped), {{{var}}} (raw),
 * {{#list}}…{{/list}} (loops / conditionals), {{^empty}}…{{/empty}}
 * (inverted), dotted paths ({{user.name}}), partials ({{>name}} resolved
 * from --partials-dir as <name>.html or <name>).
 *
 * Exits non-zero with a clear message on bad input. Refuses to overwrite
 * an existing output file unless -f is passed. Prints the output path on
 * success so callers can chain on it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import Mustache from "./vendor/mustache.mjs";

function fail(message) {
  console.error(`create-from-template: ${message}`);
  process.exit(1);
}

function usage() {
  console.error(
    [
      "Usage: create-from-template --template <file> --data <json|@file> --output <file>",
      "         [--partials-dir <dir>] [--strict] [-f]",
      "",
      "  --template      Path to the mustache template file",
      "  --data          Inline JSON object, or @path/to/data.json",
      "  --output        Path to write the rendered result",
      "  --partials-dir  Directory to resolve {{>partial}} references from",
      "  --strict        Error when the template references a missing key",
      "  -f              Overwrite the output file if it exists",
    ].join("\n"),
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = { force: false, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--template") args.template = argv[++i];
    else if (a === "--data") args.data = argv[++i];
    else if (a === "--output") args.output = argv[++i];
    else if (a === "--partials-dir") args.partialsDir = argv[++i];
    else if (a === "--strict") args.strict = true;
    else if (a === "-f" || a === "--force") args.force = true;
    else if (a === "-h" || a === "--help") usage();
    else fail(`unknown argument: ${a} (try --help)`);
  }
  return args;
}

function loadData(raw) {
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
  return data;
}

/** Collect variable references ({{name}}, {{{name}}}, {{#section}}) the
 *  data doesn't provide, so --strict can report them. Inverted sections
 *  ({{^name}}) intentionally reference absent keys and are not counted,
 *  but their bodies are still checked. */
function missingKeys(template, data) {
  const missing = new Set();
  const lookup = (stack, name) => {
    for (let s = stack.length - 1; s >= 0; s--) {
      let ctx = stack[s];
      const found = name.split(".").every((part) => {
        if (ctx !== null && typeof ctx === "object" && part in ctx) {
          ctx = ctx[part];
          return true;
        }
        return false;
      });
      if (found) return { found: true, value: ctx };
    }
    return { found: false, value: undefined };
  };
  const walk = (tokens, stack) => {
    for (const token of tokens) {
      const [type, name] = token;
      if (!/^(name|&|\{|#|\^)$/.test(type) || name === ".") continue;
      const { found, value } = lookup(stack, name);
      if (!found && type !== "^") missing.add(name);
      // Only check section bodies that would actually render, with a
      // representative child context for lists/objects.
      if (type === "#" && token[4] && found) {
        if (Array.isArray(value)) {
          if (value.length > 0) walk(token[4], [...stack, value[0]]);
        } else if (value) {
          walk(token[4], typeof value === "object" ? [...stack, value] : stack);
        }
      } else if (type === "^" && token[4]) {
        const empty =
          !found || !value || (Array.isArray(value) && value.length === 0);
        if (empty) walk(token[4], stack);
      }
    }
  };
  walk(Mustache.parse(template), [data]);
  return [...missing];
}

function loadPartials(dir) {
  return new Proxy(
    {},
    {
      get(_target, name) {
        if (typeof name !== "string") return undefined;
        for (const candidate of [name, `${name}.html`]) {
          const file = join(dir, candidate);
          if (existsSync(file) && basename(file) === candidate) {
            return readFileSync(file, "utf8");
          }
        }
        return undefined;
      },
    },
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.template || !args.data || !args.output) usage();

  const templatePath = resolve(args.template);
  if (!existsSync(templatePath)) fail(`template not found: ${args.template}`);
  const template = readFileSync(templatePath, "utf8");
  const data = loadData(args.data);

  if (args.strict) {
    const missing = missingKeys(template, data);
    if (missing.length > 0) {
      fail(`missing data for: ${missing.join(", ")}`);
    }
  }

  const outputPath = resolve(args.output);
  if (existsSync(outputPath) && !args.force) {
    fail(`output already exists: ${args.output} (pass -f to overwrite)`);
  }

  const partials = args.partialsDir
    ? loadPartials(resolve(args.partialsDir))
    : undefined;
  let rendered;
  try {
    rendered = Mustache.render(template, data, partials);
  } catch (err) {
    fail(`render failed: ${err.message}`);
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, rendered);
  console.log(outputPath);
}

if (import.meta.main) main();
