import type { IDisposable, IParser, ITheme, Terminal } from "@xterm/xterm";

export type TerminalOscColorQuerySlot = 10 | 11;
export type TerminalPixelSizeQuery = 14 | 16;
export const DEFAULT_DA1_RESPONSE = "\x1b[?1;2c";

export type TerminalParserCapabilityQuery =
  | { kind: "da1" }
  | {
      kind: "osc-color";
      slot: TerminalOscColorQuerySlot;
      body: "?" | "?;?";
    };

type TerminalCapabilityReplyHandlerDeps = {
  terminal: Pick<Terminal, "options">;
  parser: Pick<IParser, "registerCsiHandler" | "registerOscHandler">;
  sendInput: (data: string) => void;
  takeReplyAuthority: (query: TerminalParserCapabilityQuery) => boolean;
};

type TerminalParserCapabilityQueryAuthority = {
  observe: (data: Uint8Array, repliesAllowed: boolean) => void;
  reset: () => void;
  takeNativeReplyAuthority: (reply: string) => boolean | null;
  takeReplyAuthority: (query: TerminalParserCapabilityQuery) => boolean;
};

type TerminalPixelSizeResponder = {
  observe: (data: Uint8Array, repliesAllowed: boolean) => void;
  reset: () => void;
};

type TerminalPixelSizeQueryScanner = {
  observe: (data: Uint8Array, repliesAllowed: boolean) => void;
  reset: () => void;
};

type TerminalPixelGeometry = {
  cols: number;
  rows: number;
  width: number;
  height: number;
};

const PIXEL_SIZE_QUERIES = [
  { sequence: "\x1b[14t", query: 14 },
  { sequence: "\x1b[16t", query: 16 },
] as const;

type TerminalNativeReplyFamily =
  | "cpr"
  | "decrqss"
  | "device-attributes"
  | "dsr"
  | "kitty-flags"
  | "mode-report"
  | "osc-color"
  | "window-size"
  | "xtgettcap"
  | "xtversion";

type TerminalReplyQuery = {
  nativeReplyFamilies: TerminalNativeReplyFamily[];
  parserQuery?: TerminalParserCapabilityQuery;
};

type ParsedCsi = {
  final: string;
  intermediates: string;
  params: string;
  prefix: string;
};

const MAX_PENDING_QUERY_CHARS = 4096;
const NATIVE_REPLY_FAMILIES: readonly TerminalNativeReplyFamily[] = [
  "cpr",
  "decrqss",
  "device-attributes",
  "dsr",
  "kitty-flags",
  "mode-report",
  "osc-color",
  "window-size",
  "xtgettcap",
  "xtversion",
];

const OSC_COLOR_QUERY_BODIES = {
  10: [
    { body: "?", slots: [10] },
    { body: "?;?", slots: [10, 11] },
  ],
  11: [{ body: "?", slots: [11] }],
} as const satisfies Record<
  TerminalOscColorQuerySlot,
  readonly {
    body: string;
    slots: readonly TerminalOscColorQuerySlot[];
  }[]
>;

function byteToOscWord(byte: number): string {
  return byte.toString(16).padStart(2, "0").repeat(2);
}

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function rgbBytesToOsc(red: number, green: number, blue: number): string {
  return `rgb:${byteToOscWord(red)}/${byteToOscWord(green)}/${byteToOscWord(blue)}`;
}

function parseCssRgbChannel(component: string): number | null {
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(component)?.[1];
  if (percent !== undefined) {
    return clampByte((Number(percent) / 100) * 255);
  }
  if (!/^\d+(?:\.\d+)?$/.test(component)) return null;
  return clampByte(Number(component));
}

function parseCssRgb(value: string): string | null {
  const match = /^rgba?\(\s*([^)]+)\)$/i.exec(value);
  if (!match?.[1]) return null;
  const colorPart = match[1].split("/")[0]?.trim();
  if (!colorPart) return null;
  const components = colorPart.includes(",")
    ? colorPart.split(",").slice(0, 3)
    : colorPart.split(/\s+/).slice(0, 3);
  const red = components[0] ? parseCssRgbChannel(components[0].trim()) : null;
  const green = components[1] ? parseCssRgbChannel(components[1].trim()) : null;
  const blue = components[2] ? parseCssRgbChannel(components[2].trim()) : null;
  return red === null || green === null || blue === null
    ? null
    : rgbBytesToOsc(red, green, blue);
}

function parseOklchLightness(component: string): number | null {
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(component)?.[1];
  const value =
    percent === undefined ? Number(component) : Number(percent) / 100;
  return Number.isFinite(value) ? value : null;
}

function parseCssHue(component: string): number | null {
  const match = /^(-?\d+(?:\.\d+)?)(deg|grad|rad|turn)?$/i.exec(component);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  switch (match[2]?.toLowerCase()) {
    case "grad":
      return value * 0.9;
    case "rad":
      return (value * 180) / Math.PI;
    case "turn":
      return value * 360;
    default:
      return value;
  }
}

function linearSrgbToByte(channel: number): number {
  const encoded =
    channel <= 0.0031308
      ? 12.92 * channel
      : 1.055 * channel ** (1 / 2.4) - 0.055;
  return clampByte(encoded * 255);
}

function parseCssOklch(value: string): string | null {
  const match = /^oklch\(\s*([^)]+)\)$/i.exec(value);
  const colorPart = match?.[1]?.split("/")[0]?.trim();
  if (!colorPart) return null;
  const components = colorPart.split(/\s+/);
  if (components.length !== 3) return null;
  const lightness = parseOklchLightness(components[0]!);
  const chroma = Number(components[1]);
  const hue = parseCssHue(components[2]!);
  if (lightness === null || !Number.isFinite(chroma) || hue === null) {
    return null;
  }

  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lRoot ** 3;
  const m = mRoot ** 3;
  const s = sRoot ** 3;

  return rgbBytesToOsc(
    linearSrgbToByte(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearSrgbToByte(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearSrgbToByte(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  );
}

export function cssColorToOscRgb(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(trimmed)?.[1];
  if (hex) {
    const expanded =
      hex.length <= 4
        ? hex
            .slice(0, 3)
            .split("")
            .map((character) => character.repeat(2))
            .join("")
        : hex.slice(0, 6);
    return `rgb:${expanded.slice(0, 2).repeat(2)}/${expanded.slice(2, 4).repeat(2)}/${expanded.slice(4, 6).repeat(2)}`;
  }
  return parseCssRgb(trimmed) ?? parseCssOklch(trimmed);
}

export function terminalOscColorQuerySlotsForBody(
  slot: TerminalOscColorQuerySlot,
  body: string,
): readonly TerminalOscColorQuerySlot[] | null {
  return (
    OSC_COLOR_QUERY_BODIES[slot].find((entry) => entry.body === body)?.slots ??
    null
  );
}

export function terminalOscColorQueryReplies(
  theme: Pick<ITheme, "foreground" | "background">,
  slots: readonly TerminalOscColorQuerySlot[],
): string[] | null {
  const replies = slots.map((slot) => {
    const color = cssColorToOscRgb(
      slot === 10 ? theme.foreground : theme.background,
    );
    return color ? `\x1b]${slot};${color}\x1b\\` : null;
  });
  return replies.every((reply): reply is string => reply !== null)
    ? replies
    : null;
}

function guardParserHandler<Args extends unknown[]>(
  handler: (...args: Args) => boolean,
): (...args: Args) => boolean {
  return (...args) => {
    try {
      return handler(...args);
    } catch {
      return false;
    }
  };
}

function isPrimaryDeviceAttributesQuery(
  params: (number | number[])[],
): boolean {
  return params.length === 0 || (params.length === 1 && params[0] === 0);
}

export function installTerminalCapabilityReplyHandlers(
  deps: TerminalCapabilityReplyHandlerDeps,
): IDisposable {
  const oscHandler = (slot: TerminalOscColorQuerySlot) =>
    guardParserHandler((body: string) => {
      const normalizedBody = body.trim();
      const slots = terminalOscColorQuerySlotsForBody(slot, normalizedBody);
      if (!slots) return false;
      const replies = terminalOscColorQueryReplies(
        deps.terminal.options.theme ?? {},
        slots,
      );
      // Returning false leaves the query for xterm's built-in color handler.
      // Do not consume its authority unless this handler can actually reply.
      if (!replies) return false;
      const query: TerminalParserCapabilityQuery =
        slot === 10 && normalizedBody === "?;?"
          ? { kind: "osc-color", slot, body: "?;?" }
          : { kind: "osc-color", slot, body: "?" };
      if (!deps.takeReplyAuthority(query)) return true;
      for (const reply of replies) deps.sendInput(reply);
      return true;
    });
  const disposables = [
    deps.parser.registerCsiHandler(
      { final: "c" },
      guardParserHandler((params: (number | number[])[]) => {
        if (!isPrimaryDeviceAttributesQuery(params)) return false;
        if (deps.takeReplyAuthority({ kind: "da1" })) {
          deps.sendInput(DEFAULT_DA1_RESPONSE);
        }
        return true;
      }),
    ),
    deps.parser.registerOscHandler(10, oscHandler(10)),
    deps.parser.registerOscHandler(11, oscHandler(11)),
    // The raw observer below sends geometry replies before xterm writes the
    // bytes. Consume the same queries here so xterm cannot also answer them.
    deps.parser.registerCsiHandler(
      { final: "t" },
      guardParserHandler((params: (number | number[])[]) => {
        if (params.length !== 1 || Array.isArray(params[0])) return false;
        return params[0] === 14 || params[0] === 16;
      }),
    ),
  ];
  return {
    dispose: () => {
      for (const disposable of disposables) disposable.dispose();
    },
  };
}

export function terminalPixelSizeReply(
  query: TerminalPixelSizeQuery,
  geometry: TerminalPixelGeometry,
): string | null {
  if (
    geometry.cols <= 0 ||
    geometry.rows <= 0 ||
    geometry.width <= 0 ||
    geometry.height <= 0
  ) {
    return null;
  }
  const cellWidth = Math.max(1, Math.round(geometry.width / geometry.cols));
  const cellHeight = Math.max(1, Math.round(geometry.height / geometry.rows));
  const width = query === 14 ? cellWidth * geometry.cols : cellWidth;
  const height = query === 14 ? cellHeight * geometry.rows : cellHeight;
  return `\x1b[${query === 14 ? 4 : 6};${height};${width}t`;
}

function terminalScreenGeometry(
  terminal: Pick<Terminal, "cols" | "rows" | "element">,
): TerminalPixelGeometry | null {
  const screen = terminal.element?.querySelector(".xterm-screen");
  const rect = screen?.getBoundingClientRect();
  if (!rect) return null;
  return {
    cols: terminal.cols,
    rows: terminal.rows,
    width: rect.width,
    height: rect.height,
  };
}

export function createTerminalPixelSizeQueryResponder(
  terminal: Pick<Terminal, "cols" | "rows" | "element">,
  sendInput: (data: string) => void,
): TerminalPixelSizeResponder {
  return createTerminalPixelSizeQueryScanner((query, repliesAllowed) => {
    if (!repliesAllowed) return;
    const geometry = terminalScreenGeometry(terminal);
    const reply = geometry ? terminalPixelSizeReply(query, geometry) : null;
    if (reply) sendInput(reply);
  });
}

function isSameParserCapabilityQuery(
  left: TerminalParserCapabilityQuery,
  right: TerminalParserCapabilityQuery,
): boolean {
  if (left.kind !== right.kind) return false;
  return (
    left.kind === "da1" ||
    (right.kind === "osc-color" &&
      left.slot === right.slot &&
      left.body === right.body)
  );
}

function parseCsi(sequence: string): ParsedCsi | null {
  if (!sequence.startsWith("\x1b[") || sequence.length < 3) return null;
  const final = sequence.at(-1)!;
  const finalCode = final.charCodeAt(0);
  if (finalCode < 0x40 || finalCode > 0x7e) return null;

  let body = sequence.slice(2, -1);
  let prefix = "";
  const firstCode = body.charCodeAt(0);
  if (firstCode >= 0x3c && firstCode <= 0x3f) {
    prefix = body[0]!;
    body = body.slice(1);
  }
  const intermediateIndex = [...body].findIndex((character) => {
    const code = character.charCodeAt(0);
    return code >= 0x20 && code <= 0x2f;
  });
  return intermediateIndex === -1
    ? { final, intermediates: "", params: body, prefix }
    : {
        final,
        intermediates: body.slice(intermediateIndex),
        params: body.slice(0, intermediateIndex),
        prefix,
      };
}

function firstCsiParam(params: string): number | null {
  const first = params.split(";")[0]?.split(":")[0] ?? "";
  if (first === "") return 0;
  if (!/^\d+$/.test(first)) return null;
  const value = Number(first);
  return Number.isSafeInteger(value) ? value : null;
}

function parseOsc(
  sequence: string,
): { body: string; identifier: number } | null {
  if (!sequence.startsWith("\x1b]")) return null;
  const terminatorLength = sequence.endsWith("\x07")
    ? 1
    : sequence.endsWith("\x1b\\")
      ? 2
      : 0;
  if (terminatorLength === 0) return null;
  const payload = sequence.slice(2, -terminatorLength);
  const separator = payload.indexOf(";");
  if (separator === -1) return null;
  const identifier = payload.slice(0, separator);
  if (!/^\d+$/.test(identifier)) return null;
  return {
    body: payload.slice(separator + 1),
    identifier: Number(identifier),
  };
}

function nativeOscColorReplyCount(identifier: number, body: string): number {
  const slots = body.split(";");
  if (identifier === 4) {
    let count = 0;
    for (let index = 0; index + 1 < slots.length; index += 2) {
      const colorIndex = slots[index]!;
      const specification = slots[index + 1]!;
      if (!/^\d+$/.test(colorIndex)) continue;
      const parsedIndex = Number(colorIndex);
      if (parsedIndex <= 255 && specification === "?") count++;
    }
    return count;
  }
  if (identifier < 10 || identifier > 12) return 0;
  let count = 0;
  for (
    let index = 0;
    index < slots.length && identifier + index <= 12;
    index++
  ) {
    if (slots[index] === "?") count++;
  }
  return count;
}

function terminalReplyQueryForSequence(
  sequence: string,
): TerminalReplyQuery | null {
  const nativeReplyFamilies: TerminalNativeReplyFamily[] = [];
  let parserQuery: TerminalParserCapabilityQuery | undefined;
  const csi = parseCsi(sequence);
  if (csi) {
    const firstParam = firstCsiParam(csi.params);
    if (csi.final === "c" && csi.intermediates === "" && firstParam === 0) {
      if (csi.prefix === "") {
        nativeReplyFamilies.push("device-attributes");
        if (csi.params === "" || /^0+$/.test(csi.params)) {
          parserQuery = { kind: "da1" };
        }
      } else if (csi.prefix === ">" || csi.prefix === "=") {
        nativeReplyFamilies.push("device-attributes");
      }
    } else if (
      csi.final === "n" &&
      csi.intermediates === "" &&
      csi.prefix === "" &&
      firstParam === 5
    ) {
      nativeReplyFamilies.push("dsr");
    } else if (
      csi.final === "n" &&
      csi.intermediates === "" &&
      (csi.prefix === "" || csi.prefix === "?") &&
      firstParam === 6
    ) {
      nativeReplyFamilies.push("cpr");
    } else if (
      csi.final === "p" &&
      csi.intermediates === "$" &&
      (csi.prefix === "" || csi.prefix === "?") &&
      /^[0-9:;]*$/.test(csi.params)
    ) {
      nativeReplyFamilies.push("mode-report");
    } else if (
      csi.final === "t" &&
      csi.intermediates === "" &&
      csi.prefix === "" &&
      firstParam === 18
    ) {
      nativeReplyFamilies.push("window-size");
    } else if (
      csi.final === "q" &&
      csi.intermediates === "" &&
      csi.prefix === ">" &&
      csi.params === ""
    ) {
      nativeReplyFamilies.push("xtversion");
    } else if (
      csi.final === "u" &&
      csi.intermediates === "" &&
      csi.prefix === "?" &&
      csi.params === ""
    ) {
      nativeReplyFamilies.push("kitty-flags");
    }
  } else {
    const osc = parseOsc(sequence);
    if (osc) {
      if (osc.identifier === 10 || osc.identifier === 11) {
        const slot = osc.identifier;
        const normalizedBody = osc.body.trim();
        if (terminalOscColorQuerySlotsForBody(slot, normalizedBody)) {
          parserQuery = {
            kind: "osc-color",
            slot,
            body: slot === 10 && normalizedBody === "?;?" ? "?;?" : "?",
          };
        }
      }
      const nativeReplyCount = nativeOscColorReplyCount(
        osc.identifier,
        osc.body,
      );
      for (let index = 0; index < nativeReplyCount; index++) {
        nativeReplyFamilies.push("osc-color");
      }
    } else if (sequence.startsWith("\x1bP") && sequence.endsWith("\x1b\\")) {
      const body = sequence.slice(2, -2);
      const finalIndex = [...body].findIndex((character) => {
        const code = character.charCodeAt(0);
        return code >= 0x40 && code <= 0x7e;
      });
      if (finalIndex !== -1) {
        const header = body.slice(0, finalIndex + 1);
        if (header.endsWith("$q")) {
          nativeReplyFamilies.push("decrqss");
        } else if (header.endsWith("+q")) {
          nativeReplyFamilies.push("xtgettcap");
        }
      }
    }
  }

  return parserQuery || nativeReplyFamilies.length > 0
    ? { nativeReplyFamilies, parserQuery }
    : null;
}

function terminalNativeReplyFamily(
  reply: string,
): TerminalNativeReplyFamily | null {
  const csi = parseCsi(reply);
  if (csi) {
    if (
      (csi.final === "R" || csi.final === "n") &&
      csi.intermediates === "" &&
      (csi.prefix === "" || csi.prefix === "?") &&
      /^[0-9;]*$/.test(csi.params)
    ) {
      return csi.final === "R" ? "cpr" : "dsr";
    }
    if (
      csi.final === "c" &&
      csi.intermediates === "" &&
      (csi.prefix === "" ||
        csi.prefix === "?" ||
        csi.prefix === ">" ||
        csi.prefix === "=") &&
      /^[0-9;]*$/.test(csi.params)
    ) {
      return "device-attributes";
    }
    if (
      csi.final === "t" &&
      csi.intermediates === "" &&
      csi.prefix === "" &&
      /^(?:4|6|8);\d+;\d+$/.test(csi.params)
    ) {
      return "window-size";
    }
    if (
      csi.final === "y" &&
      csi.intermediates === "$" &&
      (csi.prefix === "" || csi.prefix === "?") &&
      /^[0-9;]*$/.test(csi.params)
    ) {
      return "mode-report";
    }
    if (
      csi.final === "u" &&
      csi.intermediates === "" &&
      csi.prefix === "?" &&
      /^\d+$/.test(csi.params)
    ) {
      return "kitty-flags";
    }
    return null;
  }
  if (parseOsc(reply)) return "osc-color";
  if (!reply.startsWith("\x1bP") || !reply.endsWith("\x1b\\")) {
    return null;
  }
  const body = reply.slice(2, -2);
  if (/^[01]\$r/.test(body)) return "decrqss";
  if (/^[01]\+r/.test(body)) return "xtgettcap";
  return body.startsWith(">|") ? "xtversion" : null;
}

function createTerminalReplyQueryScanner(
  onQuery: (query: TerminalReplyQuery, repliesAllowed: boolean) => void,
) {
  let pending = "";
  let pendingRepliesAllowed = false;

  const resetPending = () => {
    pending = "";
    pendingRepliesAllowed = false;
  };
  const startEscape = (repliesAllowed: boolean) => {
    pending = "\x1b";
    pendingRepliesAllowed = repliesAllowed;
  };
  const complete = () => {
    const query = terminalReplyQueryForSequence(pending);
    if (query) onQuery(query, pendingRepliesAllowed);
    resetPending();
  };

  return {
    observe: (data: Uint8Array, repliesAllowed: boolean) => {
      for (const byte of data) {
        const character = String.fromCharCode(byte);
        if (!pending) {
          if (character === "\x1b") startEscape(repliesAllowed);
          continue;
        }
        if (pending === "\x1b") {
          if (character === "[" || character === "]" || character === "P") {
            pending += character;
            pendingRepliesAllowed &&= repliesAllowed;
          } else if (character === "\x1b") {
            startEscape(repliesAllowed);
          } else {
            resetPending();
          }
          continue;
        }

        const introducer = pending[1];
        if (introducer === "[") {
          if (character === "\x1b") {
            startEscape(repliesAllowed);
            continue;
          }
          if (character === "\x18" || character === "\x1a") {
            resetPending();
            continue;
          }
          pending += character;
          pendingRepliesAllowed &&= repliesAllowed;
          const code = byte;
          if (code >= 0x40 && code <= 0x7e) complete();
        } else {
          const previousWasEscape = pending.endsWith("\x1b");
          pending += character;
          pendingRepliesAllowed &&= repliesAllowed;
          if (introducer === "]" && character === "\x07") {
            complete();
          } else if (previousWasEscape && character === "\\") {
            complete();
          } else if (previousWasEscape) {
            resetPending();
          }
        }

        if (pending.length > MAX_PENDING_QUERY_CHARS) resetPending();
      }
    },
    reset: resetPending,
  };
}

export function createTerminalParserCapabilityQueryAuthority(): TerminalParserCapabilityQueryAuthority {
  let nextQueryId = 1;
  const completed: Array<{
    id: number;
    query: TerminalParserCapabilityQuery;
    repliesAllowed: boolean;
  }> = [];
  const nativeCompleted: Record<
    TerminalNativeReplyFamily,
    Array<{ id: number; repliesAllowed: boolean }>
  > = {
    cpr: [],
    decrqss: [],
    "device-attributes": [],
    dsr: [],
    "kitty-flags": [],
    "mode-report": [],
    "osc-color": [],
    "window-size": [],
    xtgettcap: [],
    xtversion: [],
  };
  const scanner = createTerminalReplyQueryScanner((query, repliesAllowed) => {
    const id = nextQueryId++;
    if (query.parserQuery) {
      completed.push({ id, query: query.parserQuery, repliesAllowed });
    }
    for (const family of query.nativeReplyFamilies) {
      nativeCompleted[family].push({ id, repliesAllowed });
    }
  });

  const removeNativeQuery = (id: number) => {
    for (const family of NATIVE_REPLY_FAMILIES) {
      const queue = nativeCompleted[family];
      for (let index = queue.length - 1; index >= 0; index--) {
        if (queue[index]?.id === id) queue.splice(index, 1);
      }
    }
  };

  const reset = () => {
    scanner.reset();
    completed.length = 0;
    for (const family of NATIVE_REPLY_FAMILIES) {
      nativeCompleted[family].length = 0;
    }
  };

  return {
    observe: scanner.observe,
    reset,
    takeNativeReplyAuthority: (reply) => {
      const family = terminalNativeReplyFamily(reply);
      if (!family) return null;
      const next = nativeCompleted[family].shift();
      if (!next) return false;
      const parserQueryIndex = completed.findIndex(
        (candidate) => candidate.id === next.id,
      );
      if (parserQueryIndex !== -1) completed.splice(parserQueryIndex, 1);
      return next.repliesAllowed;
    },
    takeReplyAuthority: (query) => {
      const next = completed[0];
      if (!next || !isSameParserCapabilityQuery(next.query, query)) {
        return false;
      }
      completed.shift();
      removeNativeQuery(next.id);
      return next.repliesAllowed;
    },
  };
}

export function createTerminalPixelSizeQueryScanner(
  onQuery: (query: TerminalPixelSizeQuery, repliesAllowed: boolean) => void,
): TerminalPixelSizeQueryScanner {
  let pending = "";
  let pendingRepliesAllowed = false;

  const reset = () => {
    pending = "";
    pendingRepliesAllowed = false;
  };

  return {
    observe: (data, repliesAllowed) => {
      for (const byte of data) {
        const character = String.fromCharCode(byte);
        if (!pending) {
          if (character === "\x1b") {
            pending = character;
            pendingRepliesAllowed = repliesAllowed;
          }
          continue;
        }

        const candidate = pending + character;
        const matching = PIXEL_SIZE_QUERIES.filter(({ sequence }) =>
          sequence.startsWith(candidate),
        );
        if (matching.length === 0) {
          pending = character === "\x1b" ? character : "";
          pendingRepliesAllowed = character === "\x1b" && repliesAllowed;
          continue;
        }

        pending = candidate;
        pendingRepliesAllowed &&= repliesAllowed;
        const complete = matching.find(
          ({ sequence }) => sequence === candidate,
        );
        if (!complete) continue;
        onQuery(complete.query, pendingRepliesAllowed);
        reset();
      }
    },
    reset,
  };
}
