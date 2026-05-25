/**
 * Color contrast utilities. The Page Editor agent regularly produces brand
 * palettes where `muted` (used for secondary body text) or `fg` ends up at
 * < 2:1 contrast against `bg` — illegible. Rather than hoping the model
 * follows the system-prompt rules, we normalize tokens before writing them
 * so the produced design system always reads.
 *
 * Implementation: WCAG 2.x relative-luminance contrast. When a token fails
 * its minimum ratio against the background, we mix it toward the
 * page foreground color (or pure black / pure white if no fg is available)
 * until it meets the threshold — preserving hue as much as possible.
 */

export type Rgb = { r: number; g: number; b: number };

const HEX_RE = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function parseHex(input: string): Rgb | null {
  const m = input.trim().match(HEX_RE);
  if (!m) return null;
  let hex = m[1]!;
  if (hex.length === 3) {
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  }
  // 8-char hex carries alpha — drop the last 2 chars.
  if (hex.length === 8) hex = hex.slice(0, 6);
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  return { r, g, b };
}

function toHex(c: Rgb): string {
  const toC = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `#${toC(c.r)}${toC(c.g)}${toC(c.b)}`;
}

function channelLinear(n: number): number {
  const v = n / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function relativeLuminance(c: Rgb): number {
  return (
    0.2126 * channelLinear(c.r) +
    0.7152 * channelLinear(c.g) +
    0.0722 * channelLinear(c.b)
  );
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a) + 0.05;
  const lb = relativeLuminance(b) + 0.05;
  return la > lb ? la / lb : lb / la;
}

function isLight(c: Rgb): boolean {
  return relativeLuminance(c) > 0.5;
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

/**
 * Push `from` toward `toward` (a high-contrast anchor) until the result
 * meets `minRatio` against `bg`. Returns the smallest blended color that
 * passes — preserves hue better than snapping straight to fg.
 */
export function enforceContrast(
  fromHex: string,
  bgHex: string,
  options: { minRatio: number; toward?: string },
): string {
  const from = parseHex(fromHex);
  const bg = parseHex(bgHex);
  if (!from || !bg) return fromHex;
  if (contrastRatio(from, bg) >= options.minRatio) return fromHex;

  const towardHex = options.toward
    ? (parseHex(options.toward) ??
      (isLight(bg) ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 }))
    : isLight(bg)
      ? { r: 0, g: 0, b: 0 }
      : { r: 255, g: 255, b: 255 };

  // Binary search the blend factor t for the smallest t whose mix passes.
  let lo = 0;
  let hi = 1;
  let best = towardHex;
  for (let i = 0; i < 18; i++) {
    const t = (lo + hi) / 2;
    const candidate = mix(from, towardHex, t);
    if (contrastRatio(candidate, bg) >= options.minRatio) {
      best = candidate;
      hi = t;
    } else {
      lo = t;
    }
  }
  // Rounding to int channels can knock the contrast back below the
  // threshold; nudge t up in 8-bit-channel-sized steps until the rounded
  // hex actually passes.
  let result = toHex(best);
  let t = hi;
  for (let i = 0; i < 32 && t <= 1; i++) {
    const rounded = parseHex(result)!;
    if (contrastRatio(rounded, bg) >= options.minRatio) return result;
    t = Math.min(1, t + 1 / 255);
    result = toHex(mix(from, towardHex, t));
  }
  return result;
}

/**
 * Pick a readable text color to lay on top of `bgHex`. Tries the candidates
 * in order and returns the first one that hits `minRatio`; falls back to
 * pure white or pure black (whichever wins) if every candidate fails.
 *
 * Used to derive the `onPrimary` / `onSecondary` / `onAccent` tokens at
 * design-system-create time so that text rendered on colored backgrounds
 * (highlighted pricing card, primary button, accent badge) is always
 * legible no matter which hue the agent chose for the brand color.
 */
export function pickReadableText(
  bgHex: string,
  options: { candidates: string[]; minRatio?: number },
): string {
  const minRatio = options.minRatio ?? 4.5;
  const bg = parseHex(bgHex);
  if (!bg) return "#FFFFFF";
  for (const candidate of options.candidates) {
    const c = parseHex(candidate);
    if (!c) continue;
    if (contrastRatio(c, bg) >= minRatio) return toHex(c);
  }
  // No candidate passed — fall back to the higher-contrast pure choice.
  const blackRatio = contrastRatio({ r: 0, g: 0, b: 0 }, bg);
  const whiteRatio = contrastRatio({ r: 255, g: 255, b: 255 }, bg);
  return blackRatio >= whiteRatio ? "#0A0A0F" : "#FFFFFF";
}

/**
 * Ensure `surface` is *visually distinct* from `bg` without going so far
 * it competes with content. Aims for a small but perceptible lightness
 * difference (about 6% in linear luminance terms).
 */
export function ensureSurfaceDistinct(
  surfaceHex: string,
  bgHex: string,
): string {
  const surface = parseHex(surfaceHex);
  const bg = parseHex(bgHex);
  if (!surface || !bg) return surfaceHex;
  if (contrastRatio(surface, bg) >= 1.1) return surfaceHex;
  // Nudge toward the opposite end of the luminance scale.
  const anchor: Rgb = isLight(bg)
    ? { r: 0, g: 0, b: 0 }
    : { r: 255, g: 255, b: 255 };
  // ~5% toward anchor.
  return toHex(mix(surface, anchor, 0.06));
}
