"use client";

import type { ToolUIPart } from "ai";
import { LinkExternal01, Palette, Star01 } from "@untitledui/icons";
import { LatencyLabel, ToolCallShell } from "./common.tsx";
import { getEffectiveState, unwrapResult } from "./utils.tsx";

interface BrandColors {
  primary?: string;
  secondary?: string;
  accent?: string;
  background?: string;
  foreground?: string;
}

interface BrandFonts {
  heading?: string;
  body?: string;
  code?: string;
}

interface BrandContextResult {
  success?: boolean;
  error?: string;
  name?: string;
  domain?: string;
  overview?: string;
  logo?: string | null;
  favicon?: string | null;
  ogImage?: string | null;
  colors?: BrandColors | null;
  fonts?: BrandFonts | null;
}

interface BrandContextPartProps {
  part: ToolUIPart;
  latency?: number;
}

const COLOR_LABELS: Record<keyof BrandColors, string> = {
  primary: "Primary",
  secondary: "Secondary",
  accent: "Accent",
  background: "Background",
  foreground: "Foreground",
};

function domainHref(domain: string): string {
  return domain.startsWith("http") ? domain : `https://${domain}`;
}

function SectionLabel({ children }: { children: string }) {
  return (
    <span className="text-sm font-medium text-foreground">{children}</span>
  );
}

function ColorDot({ name, value }: { name: string; value: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className="size-7 shrink-0 rounded-md border border-border"
        style={{ backgroundColor: value }}
        aria-hidden
      />
      <div className="flex flex-col leading-tight min-w-0">
        <span className="text-sm text-foreground">{name}</span>
        <span className="text-xs font-mono tabular-nums text-muted-foreground">
          {value}
        </span>
      </div>
    </div>
  );
}

function FontChip({ role, family }: { role: string; family: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-muted px-4 py-3">
      <span
        className="text-2xl font-medium leading-none text-foreground shrink-0"
        style={{ fontFamily: family }}
        aria-hidden
      >
        Aa
      </span>
      <div className="flex flex-col leading-tight">
        <span className="text-xs text-muted-foreground">{role}</span>
        <span
          className="text-sm text-foreground"
          style={{ fontFamily: family }}
        >
          {family}
        </span>
      </div>
    </div>
  );
}

function BrandLogo({
  logo,
  favicon,
  name,
}: {
  logo?: string | null;
  favicon?: string | null;
  name?: string | null;
}) {
  const src = logo ?? favicon;
  if (!src) return null;
  return (
    <img
      src={src}
      alt={name ? `${name} logo` : ""}
      className="size-16 shrink-0 rounded-lg border border-border bg-background object-contain p-2"
      onError={(e) => {
        (e.target as HTMLImageElement).style.display = "none";
      }}
    />
  );
}

function ColorStrip({ colors }: { colors: BrandColors }) {
  const entries = (
    Object.entries(colors) as Array<[keyof BrandColors, string]>
  ).filter(([, v]) => typeof v === "string" && v.trim().length > 0);
  if (entries.length === 0) return null;
  return (
    <div className="flex h-1.5">
      {entries.map(([key, value]) => (
        <span
          key={key}
          className="flex-1"
          style={{ backgroundColor: value }}
          title={`${COLOR_LABELS[key]}: ${value}`}
          aria-hidden
        />
      ))}
    </div>
  );
}

function BrandCard({
  logo,
  favicon,
  name,
  domain,
  overview,
  colors,
  fonts,
  showDefaultBadge,
  isDefault,
}: {
  logo?: string | null;
  favicon?: string | null;
  name?: string | null;
  domain?: string | null;
  overview?: string | null;
  colors?: BrandColors | null;
  fonts?: BrandFonts | null;
  showDefaultBadge?: boolean;
  isDefault?: boolean;
}) {
  const colorEntries = colors
    ? (Object.entries(colors) as Array<[keyof BrandColors, string]>).filter(
        ([, v]) => typeof v === "string" && v.trim().length > 0,
      )
    : [];
  const fontEntries = fonts
    ? (Object.entries(fonts) as Array<[keyof BrandFonts, string]>).filter(
        ([, v]) => typeof v === "string" && v.trim().length > 0,
      )
    : [];

  return (
    <div className="mt-2 rounded-lg overflow-hidden border border-border">
      {colors && <ColorStrip colors={colors} />}
      <div className="p-5 flex flex-col gap-6">
        <div className="flex items-center gap-4">
          <BrandLogo logo={logo} favicon={favicon} name={name} />
          <div className="flex flex-col gap-1 min-w-0">
            {name && (
              <span className="inline-flex items-center gap-2 text-lg font-semibold text-foreground truncate">
                {name}
                {showDefaultBadge && isDefault && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                    <Star01 className="size-3 text-amber-500" />
                    default
                  </span>
                )}
              </span>
            )}
            {domain && (
              <a
                href={domainHref(domain)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                {domain}
                <LinkExternal01 className="size-3 shrink-0" />
              </a>
            )}
          </div>
        </div>

        {overview && (
          <p className="text-sm text-muted-foreground leading-relaxed">
            {overview}
          </p>
        )}

        {colorEntries.length > 0 && (
          <div className="flex flex-col gap-3">
            <SectionLabel>Colors</SectionLabel>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
              {colorEntries.map(([key, value]) => (
                <ColorDot key={key} name={COLOR_LABELS[key]} value={value} />
              ))}
            </div>
          </div>
        )}

        {fontEntries.length > 0 && (
          <div className="flex flex-col gap-3">
            <SectionLabel>Typography</SectionLabel>
            <div className="flex flex-wrap gap-2.5">
              {fontEntries.map(([role, family]) => (
                <FontChip key={role} role={role} family={family} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function BrandContextPart({ part, latency }: BrandContextPartProps) {
  const state = getEffectiveState(part.state);
  const result = unwrapResult<BrandContextResult>(part.output);
  const isLoading = state === "loading";
  const failed = state === "error" || (result && result.success === false);

  if (isLoading) {
    const input = part.input as { domain?: string } | undefined;
    return (
      <ToolCallShell
        icon={<Palette className="animate-pulse" />}
        title="Extracting brand"
        summary={input?.domain ? `from ${input.domain}` : undefined}
        state="loading"
        defaultOpen
      />
    );
  }

  if (failed) {
    return (
      <ToolCallShell
        icon={<Palette />}
        title="Brand extraction failed"
        summary={result?.error ?? "Unknown error"}
        state="error"
        trailing={<LatencyLabel latency={latency} />}
      />
    );
  }

  return (
    <>
      <ToolCallShell
        icon={<Palette className="text-fuchsia-500" />}
        title={result?.name ? `Brand set: ${result.name}` : "Brand context set"}
        summary={result?.domain}
        state="idle"
        trailing={<LatencyLabel latency={latency} />}
      />
      <BrandCard
        logo={result?.logo}
        favicon={result?.favicon}
        name={result?.name}
        domain={result?.domain}
        overview={result?.overview}
        colors={result?.colors}
        fonts={result?.fonts}
      />
    </>
  );
}

interface BrandContextRecord {
  id?: string;
  success?: boolean;
  error?: string;
  name?: string;
  domain?: string;
  overview?: string;
  logo?: string | null;
  favicon?: string | null;
  ogImage?: string | null;
  colors?: BrandColors | null;
  fonts?: BrandFonts | null;
  isDefault?: boolean;
}

interface BrandContextGetPartProps {
  part: ToolUIPart;
  latency?: number;
}

export function BrandContextGetPart({
  part,
  latency,
}: BrandContextGetPartProps) {
  const state = getEffectiveState(part.state);
  const result = unwrapResult<BrandContextRecord>(part.output);
  const isLoading = state === "loading";
  const failed = state === "error" || (result && result.success === false);

  if (isLoading) {
    return (
      <ToolCallShell
        icon={<Palette className="animate-pulse" />}
        title="Loading brand"
        state="loading"
      />
    );
  }

  if (failed || !result) {
    return (
      <ToolCallShell
        icon={<Palette />}
        title="Couldn't load brand"
        state="error"
        trailing={<LatencyLabel latency={latency} />}
      />
    );
  }

  return (
    <>
      <ToolCallShell
        icon={<Palette className="text-fuchsia-500" />}
        title={result.name ? `Brand · ${result.name}` : "Brand"}
        summary={result.domain}
        state="idle"
        trailing={<LatencyLabel latency={latency} />}
      />
      <BrandCard
        logo={result.logo}
        favicon={result.favicon}
        name={result.name}
        domain={result.domain}
        overview={result.overview}
        colors={result.colors}
        fonts={result.fonts}
        showDefaultBadge
        isDefault={result.isDefault}
      />
    </>
  );
}

interface BrandContextListResult {
  items?: BrandContextRecord[];
}

interface BrandContextListPartProps {
  part: ToolUIPart;
  latency?: number;
}

export function BrandContextListPart({
  part,
  latency,
}: BrandContextListPartProps) {
  const state = getEffectiveState(part.state);
  const result = unwrapResult<BrandContextListResult>(part.output);
  const items = Array.isArray(result?.items) ? result.items : [];
  const isLoading = state === "loading";
  const failed = state === "error";

  if (isLoading) {
    return (
      <ToolCallShell
        icon={<Palette className="animate-pulse" />}
        title="Loading brands"
        state="loading"
      />
    );
  }

  if (failed) {
    return (
      <ToolCallShell
        icon={<Palette />}
        title="Couldn't load brands"
        state="error"
        trailing={<LatencyLabel latency={latency} />}
      />
    );
  }

  if (items.length === 0) {
    return (
      <ToolCallShell
        icon={<Palette />}
        title="No brands yet"
        summary="The organization hasn't set up any brand context."
        state="idle"
        trailing={<LatencyLabel latency={latency} />}
      />
    );
  }

  return (
    <>
      <ToolCallShell
        icon={<Palette className="text-fuchsia-500" />}
        title={items.length === 1 ? "1 brand" : `${items.length} brands`}
        state="idle"
        trailing={<LatencyLabel latency={latency} />}
      />
      <div className="mt-2 flex flex-col gap-1.5">
        {items.map((brand) => {
          const colorEntries = brand.colors
            ? (
                Object.entries(brand.colors) as Array<
                  [keyof BrandColors, string]
                >
              ).filter(([, v]) => typeof v === "string" && v.trim().length > 0)
            : [];
          return (
            <div
              key={brand.id ?? `${brand.name}-${brand.domain}`}
              className="rounded-lg border border-border overflow-hidden"
            >
              {brand.colors && <ColorStrip colors={brand.colors} />}
              <div className="flex items-center gap-2.5 px-3 py-2.5">
                {(brand.logo || brand.favicon) && (
                  <img
                    src={brand.logo ?? brand.favicon ?? undefined}
                    alt=""
                    className="size-8 shrink-0 rounded-md border border-border bg-background object-contain p-0.5"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = "none";
                    }}
                  />
                )}
                <div className="flex flex-col leading-tight min-w-0 flex-1">
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground truncate">
                    {brand.name ?? "Untitled"}
                    {brand.isDefault && (
                      <Star01 className="size-3 text-amber-500 shrink-0" />
                    )}
                  </span>
                  {brand.domain && (
                    <span className="text-[11px] text-muted-foreground truncate">
                      {brand.domain}
                    </span>
                  )}
                </div>
                {colorEntries.length > 0 && (
                  <div className="flex items-center gap-0.5 shrink-0">
                    {colorEntries.slice(0, 5).map(([key, value]) => (
                      <span
                        key={key}
                        className="size-3 rounded-full border border-border"
                        style={{ backgroundColor: value }}
                        title={`${COLOR_LABELS[key]}: ${value}`}
                        aria-hidden
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
