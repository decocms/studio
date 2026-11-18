/**
 * business-case-canvas — writes the business case the Plan page shows while
 * the chat goes on. Studio renders this file as cards, so each command here
 * lights up a part of the person's screen.
 *
 *   bun business-case-canvas.mjs init --path <file> --title <t> --request <text>
 *       [--area <area>] [--objective <text>] [--thread <id>]
 *   bun business-case-canvas.mjs ask --path <file> --card <key>
 *   bun business-case-canvas.mjs set --path <file> --card <key> --summary <text>
 *       [--bullet <text>]... [--source "<label>|<url>"]... [--assumption <text>]
 *   bun business-case-canvas.mjs finish --path <file> [--document <path>]
 *   bun business-case-canvas.mjs show --path <file>
 *
 * Prints the case as JSON on stdout. Exits non-zero, writing nothing, when an
 * input is missing, unknown or too long.
 *
 * The shape and limits mirror `packages/shared/src/business-case.ts`;
 * `packages/sandbox/business-case-canvas.test.ts` keeps the two in step.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const CARD_KEYS = [
  "problem",
  "scope",
  "money",
  "competitors",
  "measurement",
  "abTest",
  "effort",
  "risks",
  "unknowns",
];

export const AREAS = [
  "pdp",
  "search",
  "category",
  "home",
  "cart",
  "checkout",
  "shipping",
  "performance",
  "paid-media",
  "other",
];

export const LIMITS = { title: 140, text: 600, item: 300, items: 8, url: 2048 };

/** Cases live at `<home>/plans/cases/<chat id>.json` and nowhere else. */
const CASE_PATH = /(^|\/)plans\/cases\/[A-Za-z0-9][A-Za-z0-9_-]*\.json$/;

const HOME_PREFIX = "/app/org/home/";

const emptyCard = () => ({ state: "empty", bullets: [], sources: [] });

const hasContent = (card) =>
  !!card.summary || card.bullets.length > 0 || card.sources.length > 0;

/** A card that was "asking" goes back to what it holds. */
const settle = (card) =>
  card.state === "asking"
    ? { ...card, state: hasContent(card) ? "filled" : "empty" }
    : card;

function tooLong(problems, name, value, max) {
  if (typeof value === "string" && value.length > max) {
    problems.push(`${name} is ${value.length} characters; the limit is ${max}`);
  }
}

function parseSource(raw, problems) {
  const at = raw.lastIndexOf("|");
  const label = (at === -1 ? raw : raw.slice(0, at)).trim();
  const url = at === -1 ? undefined : raw.slice(at + 1).trim() || undefined;
  if (!label) problems.push(`source "${raw}" has no label`);
  tooLong(problems, "source label", label, LIMITS.item);
  if (url !== undefined) {
    tooLong(problems, "source url", url, LIMITS.url);
    if (!URL.canParse(url)) problems.push(`source url "${url}" is not a URL`);
  }
  return url ? { label, url } : { label };
}

/** Problems with a whole case, in the words the agent will read. */
export function validateCase(value) {
  const problems = [];
  if (value?.version !== 1) problems.push("version must be 1");
  if (typeof value?.title !== "string" || !value.title) {
    problems.push("title is required");
  }
  tooLong(problems, "title", value?.title, LIMITS.title);
  if (!["framing", "building", "ready"].includes(value?.status)) {
    problems.push("status must be framing, building or ready");
  }
  if (typeof value?.request?.text !== "string" || !value.request.text) {
    problems.push("request is required");
  }
  tooLong(problems, "request", value?.request?.text, LIMITS.text);
  if (!AREAS.includes(value?.request?.area)) {
    problems.push(`area must be one of: ${AREAS.join(", ")}`);
  }
  tooLong(problems, "objective", value?.objective, LIMITS.text);
  for (const key of CARD_KEYS) {
    const card = value?.cards?.[key];
    if (!card) {
      problems.push(`card ${key} is missing`);
      continue;
    }
    if (!["empty", "asking", "filled"].includes(card.state)) {
      problems.push(`card ${key} has an unknown state`);
    }
    tooLong(problems, `${key} summary`, card.summary, LIMITS.text);
    tooLong(problems, `${key} assumption`, card.assumption, LIMITS.text);
    if (card.bullets.length > LIMITS.items) {
      problems.push(
        `${key} has ${card.bullets.length} bullets; at most ${LIMITS.items}`,
      );
    }
    for (const bullet of card.bullets) {
      if (!bullet) problems.push(`${key} has an empty bullet`);
      tooLong(problems, `${key} bullet`, bullet, LIMITS.item);
    }
    if (card.sources.length > LIMITS.items) {
      problems.push(
        `${key} has ${card.sources.length} sources; at most ${LIMITS.items}`,
      );
    }
  }
  tooLong(problems, "document", value?.documentPath, LIMITS.item);
  return problems;
}

function list(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function last(value) {
  return Array.isArray(value) ? value[value.length - 1] : value;
}

/** The case after `init`: a new one, or the current one reframed with every
 *  card kept. */
function frame(current, args, problems) {
  const title = last(args.title) ?? current?.title;
  const request = last(args.request) ?? current?.request?.text;
  if (!title) problems.push("--title is required");
  if (!request) problems.push("--request is required");
  const threadId = last(args.thread) ?? current?.threadId;
  return {
    version: 1,
    title,
    status: current?.status ?? "framing",
    ...(threadId ? { threadId } : {}),
    objective: last(args.objective) ?? current?.objective ?? null,
    request: {
      text: request,
      area: last(args.area) ?? current?.request?.area ?? "other",
    },
    cards:
      current?.cards ??
      Object.fromEntries(CARD_KEYS.map((key) => [key, emptyCard()])),
    ...(current?.documentPath ? { documentPath: current.documentPath } : {}),
  };
}

/** The case after `ask` or `set` on one card. Only one card asks at a time. */
function fillCard(command, current, args, problems) {
  const key = last(args.card);
  if (!CARD_KEYS.includes(key)) {
    problems.push(`--card must be one of: ${CARD_KEYS.join(", ")}`);
    return current;
  }
  const cards = Object.fromEntries(
    CARD_KEYS.map((other) => [other, settle(current.cards[other])]),
  );
  if (command === "ask") {
    cards[key] = { ...cards[key], state: "asking" };
  } else {
    const summary = last(args.summary);
    if (!summary) problems.push("--summary is required");
    const assumption = last(args.assumption);
    cards[key] = {
      state: "filled",
      summary,
      bullets: list(args.bullet).map((b) => String(b).trim()),
      sources: list(args.source).map((s) => parseSource(String(s), problems)),
      ...(assumption ? { assumption } : {}),
    };
  }
  return {
    ...current,
    status: current.status === "framing" ? "building" : current.status,
    cards,
  };
}

function finish(current, args) {
  const document = last(args.document);
  const documentPath = document?.startsWith(HOME_PREFIX)
    ? document.slice(HOME_PREFIX.length)
    : (document ?? current.documentPath);
  return {
    ...current,
    status: "ready",
    cards: Object.fromEntries(
      CARD_KEYS.map((key) => [key, settle(current.cards[key])]),
    ),
    ...(documentPath ? { documentPath } : {}),
  };
}

/** Applies one command to the case at `args.path`; returns the new case or
 *  the problems that stop it. Reads the current file, writes nothing. */
export function apply(command, args, now = new Date()) {
  const path = last(args.path);
  if (!path) return { ok: false, problems: ["--path is required"] };
  if (!CASE_PATH.test(path)) {
    return {
      ok: false,
      problems: [`--path must be ${HOME_PREFIX}plans/cases/<chat id>.json`],
    };
  }
  const known = ["init", "ask", "set", "finish", "show"];
  if (!known.includes(command)) {
    return { ok: false, problems: [`unknown command "${command}"`] };
  }
  const exists = existsSync(path);
  if (command !== "init" && !exists) {
    return { ok: false, problems: [`${path} does not exist; run init first`] };
  }
  const current = exists ? JSON.parse(readFileSync(path, "utf8")) : null;
  if (command === "show") return { ok: true, value: current, write: false };

  const problems = [];
  const next =
    command === "init"
      ? frame(current, args, problems)
      : command === "finish"
        ? finish(current, args)
        : fillCard(command, current, args, problems);
  next.updatedAt = now.toISOString();
  if (problems.length === 0) problems.push(...validateCase(next));
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: next, write: true, path };
}

/** `--flag value` pairs; a flag given twice becomes a list. */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2);
    const value = argv[i + 1];
    i++;
    out[name] = name in out ? [...list(out[name]), value] : value;
  }
  return out;
}

function main(argv) {
  const [command, ...rest] = argv;
  const result = apply(command, parseArgs(rest));
  if (!result.ok) {
    console.error(`business-case-canvas: ${result.problems.join("; ")}`);
    console.error(
      "Usage:\n" +
        "  business-case-canvas init --path <file> --title <t> --request <text> [--area <area>] [--objective <text>] [--thread <id>]\n" +
        "  business-case-canvas ask --path <file> --card <key>\n" +
        '  business-case-canvas set --path <file> --card <key> --summary <text> [--bullet <text>]... [--source "<label>|<url>"]... [--assumption <text>]\n' +
        "  business-case-canvas finish --path <file> [--document <path>]\n" +
        "  business-case-canvas show --path <file>",
    );
    process.exit(1);
  }
  if (result.write) {
    mkdirSync(dirname(result.path), { recursive: true });
    writeFileSync(result.path, `${JSON.stringify(result.value, null, 2)}\n`);
  }
  console.log(JSON.stringify(result.value, null, 2));
}

if (import.meta.main) main(process.argv.slice(2));
