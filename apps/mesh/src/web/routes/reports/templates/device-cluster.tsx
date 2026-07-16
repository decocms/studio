import { cn } from "@deco/ui/lib/utils.ts";
import { useState } from "react";
import Icon from "../icon";
import { DECK } from "./tokens";

type ShotState = "loading" | "ok" | "fail";

function Favicon({
  url,
  initial,
  size,
}: {
  url: string;
  initial: string;
  size: number;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-xl border bg-white"
      style={{ width: size, height: size, borderColor: DECK.border }}
    >
      {failed ? (
        <span
          className="font-medium"
          style={{ fontSize: size * 0.42, color: DECK.muted }}
        >
          {initial}
        </span>
      ) : (
        <img
          src={url}
          alt=""
          width={size}
          height={size}
          className="h-full w-full object-contain p-1.5"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}

/**
 * The verdict's homepage preview: a desktop browser frame with an overlapping
 * phone at the bottom-left, matching the Figma cover. Both panes show the real
 * screenshot once loaded, with a favicon placeholder while capturing.
 */
export default function DeviceCluster({
  domain,
  faviconUrl,
  initial,
  desktopShot,
  mobileShot,
  hidePhone = false,
}: {
  domain: string;
  faviconUrl: string;
  initial: string;
  desktopShot?: string;
  mobileShot?: string;
  /** Drop the overlapping phone + its gutter — a clean lone browser window
   *  (used in the tight mobile cover panel where the cluster reads as cramped). */
  hidePhone?: boolean;
}) {
  const [ds, setDs] = useState<ShotState>(desktopShot ? "loading" : "fail");
  const [ms, setMs] = useState<ShotState>(mobileShot ? "loading" : "fail");

  return (
    <div
      className={cn(
        "relative w-full max-w-[560px]",
        !hidePhone && "pb-10 pl-8",
      )}
    >
      {/* desktop browser — the ring is deliberately darker than DECK.border and
          paired with a close + ambient shadow so the white frame reads as an
          elevated card, not a shape that dissolves into the cream bg on light
          monitors. */}
      <div
        className="overflow-hidden rounded-2xl bg-white"
        style={{
          boxShadow:
            "0 0 0 1px rgba(40,37,36,0.14), 0 2px 4px rgba(40,37,36,0.05), 0 28px 56px -22px rgba(40,37,36,0.30)",
        }}
      >
        <div
          className="flex h-9 items-center gap-2 px-4"
          style={{
            background: "#f4f2ec",
            borderBottom: `1px solid ${DECK.border}`,
          }}
        >
          <span className="flex gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-black/15" />
            <span className="h-2.5 w-2.5 rounded-full bg-black/15" />
            <span className="h-2.5 w-2.5 rounded-full bg-black/15" />
          </span>
          <span
            className="mx-2 flex h-5 flex-1 items-center gap-2 rounded-md px-2.5"
            style={{ background: "#fff" }}
          >
            <Icon name="lock" size="xs" class="opacity-50" />
            <span className="truncate text-xs" style={{ color: DECK.muted }}>
              {domain}
            </span>
          </span>
        </div>
        <div
          className="relative aspect-[4/3]"
          style={{ background: "#f4f2ec" }}
        >
          {ds !== "ok" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 animate-pulse">
              <Favicon url={faviconUrl} initial={initial} size={44} />
              <span className="text-xs" style={{ color: DECK.muted }}>
                {ds === "loading"
                  ? "capturing preview…"
                  : "preview unavailable"}
              </span>
            </div>
          )}
          {desktopShot && (
            <img
              src={desktopShot}
              alt={`${domain} homepage`}
              className={cn(
                "absolute inset-0 block h-full w-full object-cover object-top transition-opacity duration-500",
                ds === "ok" ? "opacity-100" : "opacity-0",
              )}
              onLoad={() => setDs("ok")}
              onError={() => setDs("fail")}
              loading="eager"
            />
          )}
        </div>
      </div>

      {/* overlapping phone */}
      {!hidePhone && ms !== "fail" && (
        <div className="absolute bottom-0 left-0 w-[26%] max-w-[136px]">
          <div
            className="rounded-[1.5rem] p-1.5"
            style={{
              background: "#fff",
              boxShadow:
                "0 0 0 1px rgba(40,37,36,0.14), 0 2px 4px rgba(40,37,36,0.06), 0 18px 36px -16px rgba(40,37,36,0.36)",
            }}
          >
            <div className="flex h-5 items-center justify-center">
              <span className="h-1.5 w-9 rounded-full bg-black/15" />
            </div>
            <div
              className="relative aspect-[9/19] overflow-hidden rounded-[1.05rem]"
              style={{ background: "#f4f2ec" }}
            >
              {ms !== "ok" && (
                <div className="absolute inset-0 flex items-center justify-center animate-pulse">
                  <Favicon url={faviconUrl} initial={initial} size={26} />
                </div>
              )}
              {mobileShot && (
                <img
                  src={mobileShot}
                  alt={`${domain} mobile`}
                  className={cn(
                    "absolute inset-0 block h-full w-full object-cover object-top transition-opacity duration-500",
                    ms === "ok" ? "opacity-100" : "opacity-0",
                  )}
                  // Mobile captures frequently start with a sticky promo/announcement
                  // bar + a whitespace gap before the real header. The frame's crop
                  // slack isn't enough to hide it, so zoom slightly and shift up to
                  // clip that top band and land on the header.
                  style={{
                    transform: "scale(1.14) translateY(-6%)",
                    transformOrigin: "50% 0%",
                  }}
                  onLoad={() => setMs("ok")}
                  onError={() => setMs("fail")}
                  loading="eager"
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
