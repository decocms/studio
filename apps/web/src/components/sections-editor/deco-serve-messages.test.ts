import { describe, expect, test } from "bun:test";
import { ContentProtocolError, ErrorCode } from "@decocms/blocks/protocol";
import { en } from "@/i18n/en/index.ts";
import { interpolate } from "@/i18n/interpolate.ts";
import { ptBR } from "@/i18n/pt-br/index.ts";
import type { TFunction } from "@/i18n/use-t.ts";
import {
  classifyServeProbeError,
  NotDecoServeError,
  type ServeProblem,
} from "./deco-serve-connection";
import { serveProblemCopy, serveProblemShort } from "./deco-serve-notices";
import { ServeLostError, saveErrorMessage } from "./serve-save-error";

const t: TFunction = (key, vars) => interpolate(en[key], vars);
const HOST = "localhost:4545";

/** Every failure a probe meets, and the message it leads to. */
const CASES: [string, unknown, ServeProblem["reason"], RegExp][] = [
  [
    "a stopped server",
    new TypeError("Failed to fetch"),
    "not-answering",
    /isn't answering/,
  ],
  [
    "an older, token-based deco serve",
    new ContentProtocolError(ErrorCode.Unauthorized, "missing token"),
    "outdated",
    /out of date/,
  ],
  [
    "another major version",
    new ContentProtocolError(ErrorCode.Unsupported, "speaks 2.x"),
    "version-mismatch",
    /don't match/,
  ],
  [
    "another program",
    new NotDecoServeError(),
    "not-deco-serve",
    /Another program is using localhost:4545/,
  ],
  [
    "a server error",
    new ContentProtocolError(ErrorCode.InternalError, "disk full"),
    "error",
    /couldn't open your content/,
  ],
];

describe("connection messages", () => {
  for (const [name, error, reason, title] of CASES) {
    test(`${name} → ${reason}`, () => {
      const problem = classifyServeProbeError(error);
      expect(problem.reason).toBe(reason);
      const copy = serveProblemCopy(t, problem, HOST);
      expect(copy.title).toMatch(title);
      // Every message names a next step, never protocol jargon.
      expect(copy.body.length).toBeGreaterThan(40);
      for (const jargon of [/\bRPC\b/i, /endpoint/i, /protocol/i]) {
        expect(copy.title).not.toMatch(jargon);
        expect(copy.body).not.toMatch(jargon);
      }
      expect(serveProblemShort(t, problem, HOST)).toContain(
        reason === "not-answering" ? HOST : copy.title,
      );
    });
  }

  test("an error keeps the server's own words for the details", () => {
    expect(
      serveProblemCopy(t, { reason: "error", detail: "disk full" }, HOST).body,
    ).toContain('"disk full"');
  });

  test("outdated and version mismatch say to update @decocms/blocks", () => {
    for (const reason of ["outdated", "version-mismatch"] as const) {
      expect(serveProblemCopy(t, { reason }, HOST).body).toContain(
        "@decocms/blocks",
      );
    }
  });
});

describe("save messages", () => {
  test("each refusal says what to do", () => {
    const cases: [Error, RegExp][] = [
      [
        new ContentProtocolError(ErrorCode.Conflict, "a precondition failed"),
        /changed on your computer/,
      ],
      [
        new ContentProtocolError(ErrorCode.ReadOnly, "read-only"),
        /read-only.*Restart it without that flag/,
      ],
      [
        new ContentProtocolError(ErrorCode.InvalidBlock, "invalid", {
          violations: [
            { name: "Header", rule: "required", message: "title is required" },
          ],
        }),
        /rejected this content: title is required/,
      ],
      [
        new ContentProtocolError(ErrorCode.LimitExceeded, "too big"),
        /larger than deco serve accepts/,
      ],
      [
        new ServeLostError(new TypeError("Failed to fetch")),
        /stopped answering/,
      ],
    ];
    for (const [error, message] of cases) {
      const text = saveErrorMessage(t, error);
      expect(text).toMatch(/^Not saved: /);
      expect(text).toMatch(message);
      expect(text).not.toContain("Failed to fetch");
    }
  });

  test("other backends keep their own message", () => {
    expect(saveErrorMessage(t, new Error("GitHub said no"))).toBe(
      "Save failed: GitHub said no",
    );
  });
});

describe("pt-br", () => {
  test("translates every site editor connection message", () => {
    const keys = Object.keys(en).filter((key) => key.startsWith("decoServe."));
    for (const key of keys) {
      const translated = ptBR[key as keyof typeof ptBR];
      expect(translated).toBeTruthy();
      // Commands and flags stay as they are.
      for (const code of en[key as keyof typeof en].match(/`[^`]+`/g) ?? []) {
        expect(translated).toContain(code);
      }
    }
  });
});
