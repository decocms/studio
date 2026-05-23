"use client";

import type { ToolUIPart } from "ai";
import { Palette, Star01 } from "@untitledui/icons";
import { formatDuration } from "@/web/lib/format-time.ts";
import { ToolCallShell } from "./common.tsx";
import { getEffectiveState } from "./utils.tsx";

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

// MCP tool results arrive as CallToolResult ({ content, structuredContent }).
// Built-in tools (e.g. tool-brand_context_setup) skip the wrapper and pass
// the raw object as `part.output`. This unwraps either shape.
function unwrapResult<T>(output: unknown): T | undefined {
  if (output == null || typeof output !== "object") return undefined;
  const o = output as Record<string, unknown>;
  if (o.structuredContent && typeof o.structuredContent === "object") {
    return o.structuredContent as T;
  }
  if (Array.isArray(o.content)) {
    const first = (o.content as Array<{ type?: string; text?: string }>)[0];
    if (first?.type === "text" && typeof first.text === "string") {
      try {
        return JSON.parse(first.text) as T;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
  return output as T;
}

function ColorSwatch({ name, value }: { name: string; value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/20 px-2 py-1.5">
      <span
        className="size-5 shrink-0 rounded-sm border border-border/60"
        style={{ backgroundColor: value }}
        aria-hidden
      />
      <div className="flex min-w-0 flex-col leading-tight">
        <span className="text-[11px] text-muted-foreground/70">{name}</span>
        <span className="text-[11px] font-mono text-foreground">{value}</span>
      </div>
    </div>
  );
}

function FontChip({ role, family }: { role: string; family: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border/50 bg-muted/20 px-2 py-1 text-[11px]">
      <span className="font-mono text-muted-foreground/60">{role}</span>
      <span className="text-foreground" style={{ fontFamily: family }}>
        {family}
      </span>
    </span>
  );
}

export function BrandContextPart({ part, latency }: BrandContextPartProps) {
  const state = getEffectiveState(part.state);
  const result = unwrapResult<BrandContextResult>(part.output);
  const isLoading = state === "loading";
  const failed = state === "error" || (result && result.success === false);

  const latencyLabel =
    latency != null && latency > 0 ? (
      <span className="text-[11px] font-mono tabular-nums text-muted-foreground/60">
        {formatDuration(latency)}
      </span>
    ) : null;

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
        trailing={latencyLabel}
      />
    );
  }

  const colorEntries = result?.colors
    ? (
        Object.entries(result.colors) as Array<[keyof BrandColors, string]>
      ).filter(([, v]) => typeof v === "string" && v.trim().length > 0)
    : [];
  const fontEntries = result?.fonts
    ? (
        Object.entries(result.fonts) as Array<[keyof BrandFonts, string]>
      ).filter(([, v]) => typeof v === "string" && v.trim().length > 0)
    : [];

  return (
    <ToolCallShell
      icon={<Palette className="text-fuchsia-500" />}
      title={result?.name ? `Brand set: ${result.name}` : "Brand context set"}
      summary={result?.domain}
      state="idle"
      trailing={latencyLabel}
      defaultOpen
    >
      <div className="ml-[20px] mt-1 mb-2 pl-3 border-l border-border/30 flex flex-col gap-3">
        <div className="flex items-center gap-3">
          {result?.logo ? (
            <img
              src={result.logo}
              alt={`${result.name ?? "Brand"} logo`}
              className="size-12 shrink-0 rounded-md border border-border/60 bg-background object-contain p-1"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          ) : result?.favicon ? (
            <img
              src={result.favicon}
              alt=""
              className="size-12 shrink-0 rounded-md border border-border/60 bg-background object-contain p-1"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          ) : null}
          <div className="flex min-w-0 flex-col gap-0.5">
            {result?.name && (
              <span className="text-sm font-medium text-foreground truncate">
                {result.name}
              </span>
            )}
            {result?.domain && (
              <a
                href={
                  result.domain.startsWith("http")
                    ? result.domain
                    : `https://${result.domain}`
                }
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground hover:text-foreground transition-colors truncate"
              >
                {result.domain}
              </a>
            )}
          </div>
        </div>

        {colorEntries.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {colorEntries.map(([key, value]) => (
              <ColorSwatch key={key} name={COLOR_LABELS[key]} value={value} />
            ))}
          </div>
        )}

        {fontEntries.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {fontEntries.map(([role, family]) => (
              <FontChip key={role} role={role} family={family} />
            ))}
          </div>
        )}

        {result?.overview && (
          <p className="text-xs text-muted-foreground/80 leading-relaxed">
            {result.overview}
          </p>
        )}
      </div>
    </ToolCallShell>
  );
}

interface BrandContextRecord {
  id?: string;
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

function BrandHeader({
  brand,
  showDefaultBadge,
}: {
  brand: BrandContextRecord;
  showDefaultBadge?: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      {brand.logo ? (
        <img
          src={brand.logo}
          alt={`${brand.name ?? "Brand"} logo`}
          className="size-12 shrink-0 rounded-md border border-border/60 bg-background object-contain p-1"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
      ) : brand.favicon ? (
        <img
          src={brand.favicon}
          alt=""
          className="size-12 shrink-0 rounded-md border border-border/60 bg-background object-contain p-1"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
      ) : null}
      <div className="flex min-w-0 flex-col gap-0.5">
        {brand.name && (
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
            <span className="truncate">{brand.name}</span>
            {showDefaultBadge && brand.isDefault && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                <Star01 className="size-2.5" />
                default
              </span>
            )}
          </span>
        )}
        {brand.domain && (
          <a
            href={
              brand.domain.startsWith("http")
                ? brand.domain
                : `https://${brand.domain}`
            }
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors truncate"
          >
            {brand.domain}
          </a>
        )}
      </div>
    </div>
  );
}

function BrandProfileBody({ brand }: { brand: BrandContextRecord }) {
  const colorEntries = brand.colors
    ? (
        Object.entries(brand.colors) as Array<[keyof BrandColors, string]>
      ).filter(([, v]) => typeof v === "string" && v.trim().length > 0)
    : [];
  const fontEntries = brand.fonts
    ? (Object.entries(brand.fonts) as Array<[keyof BrandFonts, string]>).filter(
        ([, v]) => typeof v === "string" && v.trim().length > 0,
      )
    : [];

  return (
    <div className="ml-[20px] mt-1 mb-2 pl-3 border-l border-border/30 flex flex-col gap-3">
      <BrandHeader brand={brand} showDefaultBadge />
      {colorEntries.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {colorEntries.map(([key, value]) => (
            <ColorSwatch key={key} name={COLOR_LABELS[key]} value={value} />
          ))}
        </div>
      )}
      {fontEntries.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {fontEntries.map(([role, family]) => (
            <FontChip key={role} role={role} family={family} />
          ))}
        </div>
      )}
      {brand.overview && (
        <p className="text-xs text-muted-foreground/80 leading-relaxed">
          {brand.overview}
        </p>
      )}
    </div>
  );
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
  const failed = state === "error";

  const latencyLabel =
    latency != null && latency > 0 ? (
      <span className="text-[11px] font-mono tabular-nums text-muted-foreground/60">
        {formatDuration(latency)}
      </span>
    ) : null;

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
        trailing={latencyLabel}
      />
    );
  }

  return (
    <ToolCallShell
      icon={<Palette className="text-fuchsia-500" />}
      title={result.name ? `Brand · ${result.name}` : "Brand"}
      summary={result.domain}
      state="idle"
      trailing={latencyLabel}
      defaultOpen
    >
      <BrandProfileBody brand={result} />
    </ToolCallShell>
  );
}

function BrandColorStrip({
  colors,
}: {
  colors: BrandColors | null | undefined;
}) {
  if (!colors) return null;
  const entries = (
    Object.entries(colors) as Array<[keyof BrandColors, string]>
  ).filter(([, v]) => typeof v === "string" && v.trim().length > 0);
  if (entries.length === 0) return null;
  return (
    <div className="flex items-center gap-0.5">
      {entries.map(([key, value]) => (
        <span
          key={key}
          className="size-3 rounded-sm border border-border/50"
          style={{ backgroundColor: value }}
          title={`${COLOR_LABELS[key]} · ${value}`}
          aria-hidden
        />
      ))}
    </div>
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
  const items = result?.items ?? [];
  const isLoading = state === "loading";
  const failed = state === "error";

  const latencyLabel =
    latency != null && latency > 0 ? (
      <span className="text-[11px] font-mono tabular-nums text-muted-foreground/60">
        {formatDuration(latency)}
      </span>
    ) : null;

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
        trailing={latencyLabel}
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
        trailing={latencyLabel}
      />
    );
  }

  return (
    <ToolCallShell
      icon={<Palette className="text-fuchsia-500" />}
      title={items.length === 1 ? "1 brand" : `${items.length} brands`}
      state="idle"
      trailing={latencyLabel}
      defaultOpen
    >
      <div className="ml-[20px] mt-1 mb-2 pl-3 border-l border-border/30 flex flex-col gap-2">
        {items.map((brand) => (
          <div
            key={brand.id ?? `${brand.name}-${brand.domain}`}
            className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-muted/20 px-2.5 py-2"
          >
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              {brand.logo || brand.favicon ? (
                <img
                  src={brand.logo ?? brand.favicon ?? undefined}
                  alt=""
                  className="size-8 shrink-0 rounded-sm border border-border/60 bg-background object-contain p-0.5"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = "none";
                  }}
                />
              ) : null}
              <div className="flex min-w-0 flex-col leading-tight">
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
                  <span className="truncate">{brand.name ?? "Untitled"}</span>
                  {brand.isDefault && (
                    <Star01 className="size-3 text-amber-500" />
                  )}
                </span>
                {brand.domain && (
                  <span className="text-[11px] text-muted-foreground truncate">
                    {brand.domain}
                  </span>
                )}
              </div>
            </div>
            <BrandColorStrip colors={brand.colors} />
          </div>
        ))}
      </div>
    </ToolCallShell>
  );
}
