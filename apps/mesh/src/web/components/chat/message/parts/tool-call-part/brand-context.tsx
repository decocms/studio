"use client";

import type { ToolUIPart } from "ai";
import { Palette } from "@untitledui/icons";
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
  const result = part.output as BrandContextResult | undefined;
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
