// Renders the per-report share card (1200×630 PNG) shown when a /report link is
// unfurled. Clean and simple: the scanned site's favicon + domain, the headline
// commerce-health score, and the decocms wordmark.
//
// This DOES render an image in Studio's process — reversing the earlier "no
// in-process rendering" note — but safely: satori (pure JS) + resvg produce a
// tiny text-only card in tens of ms, the /report/:domain/og.png route caches the
// bytes per (domain, score), and the CDN caches the response, so the origin
// renders each report at most once. It can move to an edge worker later without
// touching the page. Never throws to the caller — callers fall back to the
// static card.

import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { OG_FONTS } from "./og-fonts";

const WIDTH = 1200;
const HEIGHT = 630;
const GREEN = "#07401a";
const LIME = "#d0ec1a";
const CREAM = "#f4fbe6";

/** deco "d" mark (from the brand favicon), tinted for the lime chip. */
const DECO_MARK =
  "M79.8641 145.438C97.4676 145.438 107.196 137.562 118.777 113.01C125.263 99.5758 130.358 86.1415 136.381 73.1705L143.793 75.4867C145.646 75.95 147.035 75.0235 146.109 73.1705L136.844 55.1037C136.381 53.714 134.528 53.714 133.601 54.1772L111.365 62.5157C109.512 62.979 109.512 64.832 111.365 65.2952L117.851 67.6115C112.292 79.656 105.806 98.186 100.247 109.767C94.2249 122.738 91.4454 131.54 80.7906 131.54C70.1359 131.54 68.7461 123.665 73.3786 112.084C78.4744 98.6493 86.8129 94.9433 96.0779 97.7228C98.8574 94.0168 100.71 88.4578 101.637 83.362C98.8574 82.4355 95.6146 82.4355 92.8351 82.4355C77.5479 82.4355 62.2606 90.3108 55.7751 106.988C48.8263 128.761 56.2383 145.438 79.8641 145.438Z";

/** Minimal satori vnode. Plain objects render fine; typed so we avoid `any`. */
interface VNode {
  type: string;
  props: { style?: Record<string, unknown>; children?: unknown } & Record<
    string,
    unknown
  >;
}
const h = (
  type: string,
  style: Record<string, unknown>,
  children?: unknown,
  attrs: Record<string, unknown> = {},
): VNode => ({ type, props: { ...attrs, style, children } });

/** Fetch the favicon and inline it as a data URI (satori won't fetch for us).
 *  Fail-soft: null when unavailable, so the card shows a letter tile instead. */
async function faviconDataUri(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") || "image/png";
    if (!type.startsWith("image/")) return null;
    const b64 = Buffer.from(await res.arrayBuffer()).toString("base64");
    return `data:${type};base64,${b64}`;
  } catch {
    return null;
  }
}

export interface OgCardInput {
  domain: string;
  /** Single-char fallback when the favicon can't be loaded. */
  initial: string;
  score: number;
  faviconUrl?: string;
}

/** Render the card to a PNG. Throws only on a genuine render failure. */
export async function renderOgCard(
  input: OgCardInput,
): Promise<Uint8Array<ArrayBuffer>> {
  const favicon = input.faviconUrl
    ? await faviconDataUri(input.faviconUrl)
    : null;

  const faviconTile = favicon
    ? h(
        "div",
        {
          width: 84,
          height: 84,
          borderRadius: 20,
          backgroundColor: CREAM,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        },
        h("img", {}, null, { src: favicon, width: 56, height: 56 }),
      )
    : h(
        "div",
        {
          width: 84,
          height: 84,
          borderRadius: 20,
          backgroundColor: LIME,
          color: GREEN,
          fontSize: 44,
          fontWeight: 700,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        },
        (input.initial || input.domain.charAt(0) || "?").toUpperCase(),
      );

  const tree = h(
    "div",
    {
      width: WIDTH,
      height: HEIGHT,
      display: "flex",
      flexDirection: "column",
      justifyContent: "space-between",
      padding: "72px 80px",
      backgroundColor: GREEN,
      color: CREAM,
      fontFamily: "Inter",
    },
    [
      // top — the scanned site's identity
      h("div", { display: "flex", alignItems: "center", gap: 22 }, [
        faviconTile,
        h("div", { display: "flex", flexDirection: "column" }, [
          h(
            "div",
            { fontSize: 24, color: LIME, fontWeight: 600, marginBottom: 4 },
            "Commerce report",
          ),
          h(
            "div",
            { fontSize: 46, fontWeight: 600, letterSpacing: "-0.02em" },
            input.domain,
          ),
        ]),
      ]),
      // middle — the score
      h("div", { display: "flex", alignItems: "flex-end", gap: 28 }, [
        h(
          "div",
          {
            fontSize: 220,
            fontWeight: 700,
            color: LIME,
            lineHeight: 0.82,
            letterSpacing: "-0.05em",
          },
          String(Math.round(input.score)),
        ),
        h(
          "div",
          {
            fontSize: 60,
            fontWeight: 400,
            color: "rgba(244,251,230,0.55)",
            paddingBottom: 30,
          },
          "/100",
        ),
        h(
          "div",
          {
            fontSize: 30,
            fontWeight: 400,
            color: "rgba(244,251,230,0.82)",
            paddingBottom: 40,
          },
          "Commerce health score",
        ),
      ]),
      // bottom — decocms wordmark
      h("div", { display: "flex", alignItems: "center", gap: 14 }, [
        h(
          "div",
          {
            width: 44,
            height: 44,
            borderRadius: 11,
            backgroundColor: LIME,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          },
          h("svg", {}, h("path", {}, null, { d: DECO_MARK, fill: GREEN }), {
            width: 30,
            height: 30,
            viewBox: "0 0 200 200",
          }),
        ),
        h("div", { fontSize: 26, fontWeight: 700 }, "decocms"),
      ]),
    ],
  );

  const svg = await satori(tree as unknown as Parameters<typeof satori>[0], {
    width: WIDTH,
    height: HEIGHT,
    fonts: OG_FONTS,
  });
  const png = new Resvg(svg, { fitTo: { mode: "width", value: WIDTH } })
    .render()
    .asPng();
  // Copy into a fresh ArrayBuffer-backed view (satisfies Hono's body type and
  // detaches from resvg's internal buffer).
  return Uint8Array.from(png);
}
