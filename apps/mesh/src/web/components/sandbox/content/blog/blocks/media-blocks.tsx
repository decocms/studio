import { useState } from "react";
import { ImageField } from "@/web/components/sections-editor/fields/image-field";
import { cn } from "@deco/ui/lib/utils.js";
import { FloatingToolbar, InlineText, ToolbarButton, str } from "./primitives";

// ---------------------------------------------------------------- Image

export function BlockImageBlock({
  block,
  onChange,
}: {
  block: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const size = str(block.size) || "normal";
  return (
    <div className="space-y-2">
      <ImageField
        schema={{ type: "string", format: "image-uri", title: "Image" }}
        value={block.url}
        onChange={(v) => onChange({ ...block, url: v })}
        path="block-image-url"
        label="Image"
      />
      <InlineText
        value={str(block.caption)}
        onChange={(v) => onChange({ ...block, caption: v })}
        placeholder="Add a caption…"
        className="text-center text-sm italic text-muted-foreground"
      />
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <div className="flex items-center gap-1">
          {(["normal", "full"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onChange({ ...block, size: s })}
              className={cn(
                "rounded px-2 py-0.5 transition-colors cursor-pointer",
                size === s
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-muted",
              )}
            >
              {s === "full" ? "Full width" : "Normal"}
            </button>
          ))}
        </div>
        <input
          value={str(block.alt)}
          onChange={(e) => onChange({ ...block, alt: e.target.value })}
          placeholder="Alt text (accessibility)"
          className="flex-1 border-0 bg-transparent p-0 text-xs outline-none placeholder:text-muted-foreground/50 focus:ring-0"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Video

function youtubeOrVimeoEmbed(raw: string): string | null {
  const yt = raw.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/);
  if (yt) return `https://www.youtube.com/embed/${yt[1]}`;
  const vimeo = raw.match(/vimeo\.com\/(\d+)/);
  if (vimeo) return `https://player.vimeo.com/video/${vimeo[1]}`;
  return null;
}

export function VideoBlock({
  url,
  caption,
  onChange,
}: {
  url: string;
  caption: string;
  onChange: (next: { url: string; caption: string }) => void;
}) {
  const embed = youtubeOrVimeoEmbed(url);
  return (
    <div className="space-y-2">
      {embed ? (
        <div className="relative aspect-video overflow-hidden rounded-md border bg-muted">
          <iframe
            src={embed}
            title={caption || "Video"}
            className="absolute inset-0 h-full w-full border-0"
            allowFullScreen
          />
        </div>
      ) : (
        <div className="flex aspect-video items-center justify-center rounded-md border border-dashed bg-muted/40 text-xs text-muted-foreground">
          Paste a YouTube or Vimeo URL to preview
        </div>
      )}
      <input
        value={url}
        onChange={(e) => onChange({ url: e.target.value, caption })}
        placeholder="https://youtube.com/watch?v=…"
        className="h-9 w-full rounded-md border bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground/50 focus:ring-0"
      />
      <InlineText
        value={caption}
        onChange={(v) => onChange({ url, caption: v })}
        placeholder="Add a caption…"
        className="text-center text-sm italic text-muted-foreground"
      />
    </div>
  );
}

// ---------------------------------------------------------------- Divider

export function DividerBlock() {
  return (
    <div className="flex items-center py-3" aria-label="Divider">
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

// ---------------------------------------------------------------- CTA

export function CtaBlock({
  text,
  href,
  onChange,
}: {
  text: string;
  href: string;
  onChange: (next: { text: string; href: string }) => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2 py-2">
      <div className="inline-flex items-center rounded-full bg-primary px-6 py-2 text-sm font-semibold text-primary-foreground">
        <input
          value={text}
          onChange={(e) => onChange({ text: e.target.value, href })}
          placeholder="Button label"
          size={Math.max(text.length || 11, 8)}
          className="border-0 bg-transparent p-0 text-center text-sm font-semibold text-primary-foreground outline-none placeholder:text-primary-foreground/60 focus:ring-0"
        />
      </div>
      <input
        value={href}
        onChange={(e) => onChange({ text, href: e.target.value })}
        placeholder="https://destination-url.com"
        className="w-full max-w-sm border-0 bg-transparent p-0 text-center text-xs text-muted-foreground outline-none placeholder:text-muted-foreground/50 focus:ring-0"
      />
    </div>
  );
}

// ---------------------------------------------------------------- Callout

const CALLOUT_VARIANTS = [
  { value: "info", icon: "ℹ", color: "oklch(0.62 0.19 250)" },
  { value: "tip", icon: "✓", color: "oklch(0.65 0.17 150)" },
  { value: "warning", icon: "⚠", color: "oklch(0.75 0.15 75)" },
  { value: "product", icon: "★", color: "oklch(0.62 0.21 300)" },
] as const;

export function CalloutBlock({
  title,
  body,
  variant,
  onChange,
}: {
  title: string;
  body: string;
  variant: string;
  onChange: (next: { title: string; body: string; variant: string }) => void;
}) {
  const [focused, setFocused] = useState(false);
  const v =
    CALLOUT_VARIANTS.find((x) => x.value === variant) ?? CALLOUT_VARIANTS[0];

  return (
    <div
      className="relative"
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setFocused(false);
        }
      }}
    >
      {focused && (
        <FloatingToolbar>
          {CALLOUT_VARIANTS.map((opt) => (
            <ToolbarButton
              key={opt.value}
              active={v.value === opt.value}
              label={opt.value}
              onClick={() => onChange({ title, body, variant: opt.value })}
            >
              <span style={{ color: opt.color }}>{opt.icon}</span>
            </ToolbarButton>
          ))}
        </FloatingToolbar>
      )}
      <div
        className="rounded-md py-4 pl-5 pr-4"
        style={{
          borderLeft: `3px solid ${v.color}`,
          backgroundColor: `color-mix(in oklch, ${v.color} 8%, transparent)`,
        }}
      >
        <div
          className="mb-1.5 flex items-center gap-2"
          style={{ color: v.color }}
        >
          <span aria-hidden className="text-sm font-bold leading-none">
            {v.icon}
          </span>
          <input
            value={title}
            onChange={(e) => onChange({ title: e.target.value, body, variant })}
            placeholder="Callout title"
            className="flex-1 border-0 bg-transparent p-0 text-xs font-semibold uppercase tracking-wide outline-none focus:ring-0"
            style={{ color: v.color }}
          />
        </div>
        <InlineText
          value={body}
          onChange={(b) => onChange({ title, body: b, variant })}
          placeholder="Callout text…"
          className="text-[15px] leading-relaxed text-foreground"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Stat

export function StatBlock({
  value,
  label,
  description,
  onChange,
}: {
  value: string;
  label: string;
  description: string;
  onChange: (next: {
    value: string;
    label: string;
    description: string;
  }) => void;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5 border-y border-border/60 py-8 text-center">
      <input
        value={value}
        onChange={(e) =>
          onChange({ value: e.target.value, label, description })
        }
        placeholder="42%"
        className="w-full border-0 bg-transparent p-0 text-center text-4xl font-bold tabular-nums text-foreground outline-none placeholder:text-muted-foreground/40 focus:ring-0"
      />
      <input
        value={label}
        onChange={(e) =>
          onChange({ value, label: e.target.value, description })
        }
        placeholder="Label"
        className="w-full border-0 bg-transparent p-0 text-center text-xs font-semibold uppercase tracking-wide text-muted-foreground outline-none placeholder:text-muted-foreground/40 focus:ring-0"
      />
      <InlineText
        value={description}
        onChange={(d) => onChange({ value, label, description: d })}
        placeholder="Optional description"
        className="max-w-md text-center text-sm text-muted-foreground"
      />
    </div>
  );
}
