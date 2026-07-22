import { Image01 } from "@untitledui/icons";
import type { TranslationKey } from "@/web/i18n/use-t";
import { useT } from "@/web/i18n/use-t";
import { safeEditorImageUrl } from "./safe-editor-image-url";

/**
 * Live, multi-platform preview of how a page's SEO/Open-Graph metadata renders
 * across search and social/chat apps. Read-only — purely reflects the current
 * SEO form values so editors can see the result while they type.
 *
 * The cards intentionally use fixed (non-theme) colors: they emulate the real
 * apps (Google's blue link, Discord's dark embed, …), so they look the same in
 * light and dark mode, like a screenshot would.
 */

interface SeoValues {
  title?: string;
  description?: string;
  image?: string;
  favicon?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function safePreviewImageUrl(
  raw: string | undefined,
  baseUrl: string | null | undefined,
): string | undefined {
  if (!raw) return undefined;
  if (baseUrl) {
    try {
      const resolved = new URL(raw, baseUrl).href;
      return safeEditorImageUrl(resolved);
    } catch {
      return undefined;
    }
  }
  return safeEditorImageUrl(raw);
}

function readSeo(seo: Record<string, unknown> | null | undefined): SeoValues {
  if (!seo) return {};
  const rawTitle = str(seo.title);
  const template = str(seo.titleTemplate);
  const title =
    rawTitle && template?.includes("%s")
      ? template.replace(/%s/g, rawTitle)
      : rawTitle;
  return {
    title,
    description: str(seo.description),
    image: str(seo.image),
    favicon: str(seo.favicon),
  };
}

function hostFromUrl(url: string | null | undefined): string {
  if (!url) return "example.com";
  try {
    return new URL(url).host;
  } catch {
    return "example.com";
  }
}

type Layout = "search" | "card" | "chat" | "attachment";

interface PlatformDef {
  id: string;
  labelKey: TranslationKey;
  color: string;
  layout: Layout;
}

const PLATFORMS: PlatformDef[] = [
  {
    id: "google",
    labelKey: "sectionsEditor.seoPreview.platformGoogle",
    color: "#4285F4",
    layout: "search",
  },
  {
    id: "facebook",
    labelKey: "sectionsEditor.seoPreview.platformFacebook",
    color: "#1877F2",
    layout: "card",
  },
  {
    id: "twitter",
    labelKey: "sectionsEditor.seoPreview.platformTwitter",
    color: "#0f1419",
    layout: "card",
  },
  {
    id: "linkedin",
    labelKey: "sectionsEditor.seoPreview.platformLinkedin",
    color: "#0A66C2",
    layout: "card",
  },
  {
    id: "whatsapp",
    labelKey: "sectionsEditor.seoPreview.platformWhatsapp",
    color: "#25D366",
    layout: "chat",
  },
  {
    id: "telegram",
    labelKey: "sectionsEditor.seoPreview.platformTelegram",
    color: "#229ED9",
    layout: "chat",
  },
  {
    id: "slack",
    labelKey: "sectionsEditor.seoPreview.platformSlack",
    color: "#611f69",
    layout: "attachment",
  },
  {
    id: "discord",
    labelKey: "sectionsEditor.seoPreview.platformDiscord",
    color: "#5865F2",
    layout: "attachment",
  },
];

function PreviewImage({
  src,
  className,
  iconSize = 20,
}: {
  src?: string;
  className?: string;
  iconSize?: number;
}) {
  if (src) {
    return (
      <img
        src={src}
        alt=""
        referrerPolicy="no-referrer"
        className={className}
        style={{ objectFit: "cover" }}
      />
    );
  }
  return (
    <div
      className={className}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#e5e7eb",
        color: "#9ca3af",
      }}
    >
      <Image01 size={iconSize} />
    </div>
  );
}

function GoogleCard({
  seo,
  host,
  path,
  t,
}: PreviewBodyProps & { t: ReturnType<typeof useT> }) {
  return (
    <div
      className="rounded-lg p-3 text-left"
      style={{ background: "#fff", border: "1px solid #dadce0" }}
    >
      <div className="flex items-center gap-2">
        <div
          className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full"
          style={{ background: "#f1f3f4" }}
        >
          {seo.favicon ? (
            <img src={seo.favicon} alt="" className="size-full object-cover" />
          ) : (
            <Image01 size={12} color="#9aa0a6" />
          )}
        </div>
        <div className="min-w-0">
          <div
            className="truncate text-[13px] leading-tight"
            style={{ color: "#202124" }}
          >
            {host}
          </div>
          <div
            className="truncate text-[12px] leading-tight"
            style={{ color: "#4d5156" }}
          >
            {host}
            {path}
          </div>
        </div>
      </div>
      <div
        className="mt-1.5 truncate text-[18px] leading-snug"
        style={{ color: "#1a0dab" }}
      >
        {seo.title ?? t("sectionsEditor.seoPreview.fallbackTitle")}
      </div>
      <div
        className="mt-0.5 line-clamp-2 text-[13px] leading-snug"
        style={{ color: "#4d5156" }}
      >
        {seo.description ?? t("sectionsEditor.seoPreview.fallbackDescription")}
      </div>
    </div>
  );
}

function OgCard({
  seo,
  host,
  t,
}: PreviewBodyProps & { t: ReturnType<typeof useT> }) {
  return (
    <div
      className="overflow-hidden rounded-lg text-left"
      style={{ background: "#fff", border: "1px solid #e2e8f0" }}
    >
      <PreviewImage src={seo.image} className="h-40 w-full" />
      <div className="px-3 py-2" style={{ borderTop: "1px solid #e2e8f0" }}>
        <div className="truncate text-[11px]" style={{ color: "#8a9099" }}>
          {host}
        </div>
        <div
          className="line-clamp-1 text-[14px] font-semibold"
          style={{ color: "#1c2024" }}
        >
          {seo.title ?? t("sectionsEditor.seoPreview.fallbackTitle")}
        </div>
        <div className="line-clamp-2 text-[12px]" style={{ color: "#60666c" }}>
          {seo.description ??
            t("sectionsEditor.seoPreview.fallbackDescription")}
        </div>
      </div>
    </div>
  );
}

function ChatCard({
  seo,
  host,
  accent,
  t,
}: PreviewBodyProps & { accent: string; t: ReturnType<typeof useT> }) {
  return (
    <div className="rounded-lg p-2 text-left" style={{ background: "#f0f2f5" }}>
      <p className="px-1 pb-1.5 text-[12px]" style={{ color: "#3b4045" }}>
        {t("sectionsEditor.seoPreview.chatCardHint")}
      </p>
      <div
        className="overflow-hidden rounded-md"
        style={{
          background: "#fff",
          borderLeft: `3px solid ${accent}`,
        }}
      >
        <PreviewImage src={seo.image} className="h-28 w-full" iconSize={18} />
        <div className="px-2.5 py-1.5">
          <div
            className="line-clamp-1 text-[12px] font-semibold"
            style={{ color: "#1c2024" }}
          >
            {seo.title ?? t("sectionsEditor.seoPreview.fallbackTitle")}
          </div>
          <div
            className="line-clamp-2 text-[11px]"
            style={{ color: "#60666c" }}
          >
            {seo.description ??
              t("sectionsEditor.seoPreview.fallbackDescription")}
          </div>
          <div className="mt-0.5 text-[10px]" style={{ color: "#8a9099" }}>
            {host}
          </div>
        </div>
      </div>
    </div>
  );
}

function AttachmentCard({
  seo,
  host,
  accent,
  dark,
  t,
}: PreviewBodyProps & {
  accent: string;
  dark?: boolean;
  t: ReturnType<typeof useT>;
}) {
  const bg = dark ? "#2b2d31" : "#fff";
  const titleColor = dark ? "#00a8fc" : "#1264a3";
  const descColor = dark ? "#dbdee1" : "#3b4045";
  const metaColor = dark ? "#949ba4" : "#8a9099";
  return (
    <div
      className="rounded-lg p-2.5 text-left"
      style={{ background: bg, border: dark ? "none" : "1px solid #e2e8f0" }}
    >
      <div
        className="flex gap-2.5 pl-2.5"
        style={{ borderLeft: `3px solid ${accent}`, borderRadius: 2 }}
      >
        <div className="min-w-0 flex-1">
          <div className="text-[10px]" style={{ color: metaColor }}>
            {host}
          </div>
          <div
            className="line-clamp-1 text-[13px] font-semibold"
            style={{ color: titleColor }}
          >
            {seo.title ?? t("sectionsEditor.seoPreview.fallbackTitle")}
          </div>
          <div
            className="line-clamp-2 text-[12px]"
            style={{ color: descColor }}
          >
            {seo.description ??
              t("sectionsEditor.seoPreview.fallbackDescription")}
          </div>
        </div>
        <PreviewImage
          src={seo.image}
          className="size-14 shrink-0 rounded"
          iconSize={16}
        />
      </div>
    </div>
  );
}

interface PreviewBodyProps {
  seo: SeoValues;
  host: string;
  path: string;
}

function PlatformCard({
  platform,
  seo,
  host,
  path,
  t,
}: {
  platform: PlatformDef;
  seo: SeoValues;
  host: string;
  path: string;
  t: ReturnType<typeof useT>;
}) {
  const body =
    platform.layout === "search" ? (
      <GoogleCard seo={seo} host={host} path={path} t={t} />
    ) : platform.layout === "card" ? (
      <OgCard seo={seo} host={host} path={path} t={t} />
    ) : platform.layout === "chat" ? (
      <ChatCard
        seo={seo}
        host={host}
        path={path}
        accent={platform.color}
        t={t}
      />
    ) : (
      <AttachmentCard
        seo={seo}
        host={host}
        path={path}
        accent={platform.color}
        dark={platform.id === "discord"}
        t={t}
      />
    );

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5">
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ background: platform.color }}
        />
        <span className="text-xs font-medium text-muted-foreground">
          {t(platform.labelKey)}
        </span>
      </div>
      {body}
    </div>
  );
}

export function SeoPreview({
  seo,
  url,
  path = "/",
}: {
  seo: Record<string, unknown> | null | undefined;
  url: string | null | undefined;
  path?: string;
}) {
  const t = useT();
  const raw = readSeo(seo);
  const values: SeoValues = {
    ...raw,
    image: safePreviewImageUrl(raw.image, url),
    favicon: safePreviewImageUrl(raw.favicon, url),
  };
  const host = hostFromUrl(url);
  const displayPath = path === "/" ? "" : path;

  return (
    <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2">
      {PLATFORMS.map((platform) => (
        <PlatformCard
          key={platform.id}
          platform={platform}
          seo={values}
          host={host}
          path={displayPath}
          t={t}
        />
      ))}
    </div>
  );
}
