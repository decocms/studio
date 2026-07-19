import { useState } from "react";
import { Controller, type UseFormReturn } from "react-hook-form";
import { LinkExternal01, Globe02, Zap } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";

// --- Types ---

export type BrandColors = {
  primary?: string;
  secondary?: string;
  accent?: string;
  background?: string;
  foreground?: string;
};

export type BrandFonts = {
  heading?: string;
  body?: string;
  code?: string;
};

// --- Section card wrapper (visual container only — autosave handles saves) ---

export function BrandCard({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-border/60 bg-background p-5",
        className,
      )}
    >
      <div className="mb-4">
        <span className="text-xs font-medium text-muted-foreground">
          {title}
        </span>
      </div>
      {children}
    </div>
  );
}

// --- Form data covering all editable brand fields ---

export interface BrandFormData {
  name: string;
  domain: string;
  overview: string;
  logo: string;
  favicon: string;
  ogImage: string;
  fonts: BrandFonts;
  colors: BrandColors;
}

export type BrandFormReturn = UseFormReturn<BrandFormData>;

// --- Auto-extract banner ---

export function AutoExtractBanner({
  onExtract,
  isExtracting,
}: {
  onExtract: (domain: string) => void;
  isExtracting?: boolean;
}) {
  const [domain, setDomain] = useState("");

  return (
    <div className="rounded-2xl border border-dashed border-border bg-muted/30 p-5">
      <div className="flex items-start gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
          <Zap size={18} className="text-primary" />
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium text-foreground">
            Auto-extract brand context
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Enter your website URL and we'll automatically extract your brand
            colors, fonts, logos, and company overview.
          </p>
          <div className="mt-3 flex gap-2">
            <Input
              placeholder="acme.com"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              className="max-w-xs"
              onKeyDown={(e) => {
                if (e.key === "Enter" && domain.trim() && !isExtracting) {
                  onExtract(domain.trim());
                }
              }}
            />
            <Button
              variant="outline"
              disabled={!domain.trim() || isExtracting}
              onClick={() => onExtract(domain.trim())}
            >
              <Globe02 size={14} />
              {isExtracting ? "Extracting..." : "Extract"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Section: Company Overview ---

export function OverviewSection({
  form,
  onFieldChange,
  onFieldCommit,
}: {
  form: BrandFormReturn;
  onFieldChange: () => void;
  onFieldCommit: () => void;
}) {
  const domain = form.watch("domain");

  return (
    <BrandCard title="Company Overview">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              Company name
            </label>
            <Controller
              control={form.control}
              name="name"
              render={({ field }) => (
                <Input
                  {...field}
                  onChange={(e) => {
                    field.onChange(e);
                    onFieldChange();
                  }}
                  onBlur={() => {
                    field.onBlur();
                    onFieldCommit();
                  }}
                  placeholder="Acme Corp"
                />
              )}
            />
          </div>
          <div>
            <label className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
              <span>Domain</span>
              {domain && (
                <a
                  href={`https://${domain}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 transition-colors hover:text-foreground"
                >
                  <LinkExternal01 size={10} />
                  open
                </a>
              )}
            </label>
            <Controller
              control={form.control}
              name="domain"
              render={({ field }) => (
                <Input
                  {...field}
                  onChange={(e) => {
                    field.onChange(e);
                    onFieldChange();
                  }}
                  onBlur={() => {
                    field.onBlur();
                    onFieldCommit();
                  }}
                  placeholder="acme.com"
                />
              )}
            />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            Overview
          </label>
          <Controller
            control={form.control}
            name="overview"
            render={({ field }) => (
              <Textarea
                {...field}
                onChange={(e) => {
                  field.onChange(e);
                  onFieldChange();
                }}
                onBlur={() => {
                  field.onBlur();
                  onFieldCommit();
                }}
                placeholder="Brief description of what the company does..."
                rows={3}
              />
            )}
          />
        </div>
      </div>
    </BrandCard>
  );
}

// --- Section: Logos ---

const CHECKERED_BG = {
  backgroundImage:
    "linear-gradient(45deg, #e5e7eb 25%, transparent 25%, transparent 75%, #e5e7eb 75%), linear-gradient(45deg, #e5e7eb 25%, transparent 25%, transparent 75%, #e5e7eb 75%)",
  backgroundSize: "8px 8px",
  backgroundPosition: "0 0, 4px 4px",
  backgroundColor: "#fff",
};

function LogoFieldRow({
  form,
  name,
  label,
  imgClassName = "h-full w-full object-contain p-3",
  onFieldChange,
  onFieldCommit,
}: {
  form: BrandFormReturn;
  name: "logo" | "favicon" | "ogImage";
  label: string;
  imgClassName?: string;
  onFieldChange: () => void;
  onFieldCommit: () => void;
}) {
  const value = form.watch(name);
  return (
    <div className="flex items-start gap-3">
      <div
        className="flex aspect-video w-28 shrink-0 items-center justify-center overflow-hidden rounded-xl"
        style={CHECKERED_BG}
      >
        {value ? (
          <img
            src={value}
            alt={label}
            className={imgClassName}
            loading="lazy"
          />
        ) : (
          <span className="text-[10px] text-muted-foreground/70">
            No {label.toLowerCase()}
          </span>
        )}
      </div>
      <div className="flex-1">
        <label className="mb-1 block text-xs text-muted-foreground">
          {label} URL
        </label>
        <Controller
          control={form.control}
          name={name}
          render={({ field }) => (
            <Input
              {...field}
              onChange={(e) => {
                field.onChange(e);
                onFieldChange();
              }}
              onBlur={() => {
                field.onBlur();
                onFieldCommit();
              }}
              placeholder="https://..."
            />
          )}
        />
      </div>
    </div>
  );
}

export function LogosSection({
  form,
  onFieldChange,
  onFieldCommit,
}: {
  form: BrandFormReturn;
  onFieldChange: () => void;
  onFieldCommit: () => void;
}) {
  return (
    <BrandCard title="Logos & Images">
      <div className="space-y-3">
        <LogoFieldRow
          form={form}
          name="logo"
          label="Logo"
          onFieldChange={onFieldChange}
          onFieldCommit={onFieldCommit}
        />
        <LogoFieldRow
          form={form}
          name="favicon"
          label="Favicon"
          imgClassName="h-12 w-12 object-contain"
          onFieldChange={onFieldChange}
          onFieldCommit={onFieldCommit}
        />
        <LogoFieldRow
          form={form}
          name="ogImage"
          label="SEO / OG image"
          imgClassName="h-full w-full object-contain"
          onFieldChange={onFieldChange}
          onFieldCommit={onFieldCommit}
        />
      </div>
    </BrandCard>
  );
}

// --- Section: Fonts ---

const FONT_ROLES = [
  { key: "heading" as const, label: "Headings" },
  { key: "body" as const, label: "Body" },
  { key: "code" as const, label: "Code" },
];

export function FontsSection({
  form,
  onFieldChange,
  onFieldCommit,
}: {
  form: BrandFormReturn;
  onFieldChange: () => void;
  onFieldCommit: () => void;
}) {
  return (
    <BrandCard title="Fonts">
      <div className="space-y-2">
        {FONT_ROLES.map(({ key, label }) => {
          const fieldName = `fonts.${key}` as const;
          const value = form.watch(fieldName);
          return (
            <div key={key}>
              <label className="mb-1 flex items-center gap-3 text-xs text-muted-foreground">
                <span className="w-7 text-base font-medium leading-none text-foreground">
                  Aa
                </span>
                <span>{label}</span>
                {value && (
                  <span
                    className="ml-auto truncate text-foreground"
                    style={{ fontFamily: value }}
                  >
                    {value}
                  </span>
                )}
              </label>
              <Controller
                control={form.control}
                name={fieldName}
                render={({ field }) => (
                  <Input
                    {...field}
                    value={field.value ?? ""}
                    onChange={(e) => {
                      field.onChange(e);
                      onFieldChange();
                    }}
                    onBlur={() => {
                      field.onBlur();
                      onFieldCommit();
                    }}
                    placeholder={`Font family for ${label.toLowerCase()}`}
                  />
                )}
              />
            </div>
          );
        })}
      </div>
    </BrandCard>
  );
}

// --- Section: Colors ---

const COLOR_ROLES = [
  { key: "primary" as const, label: "Primary" },
  { key: "secondary" as const, label: "Secondary" },
  { key: "accent" as const, label: "Accent" },
  { key: "background" as const, label: "Background" },
  { key: "foreground" as const, label: "Foreground" },
];

export function ColorsSection({
  form,
  onFieldChange,
  onFieldCommit,
}: {
  form: BrandFormReturn;
  onFieldChange: () => void;
  onFieldCommit: () => void;
}) {
  return (
    <BrandCard title="Colors">
      <div className="space-y-2">
        {COLOR_ROLES.map(({ key, label }) => {
          const fieldName = `colors.${key}` as const;
          return (
            <Controller
              key={key}
              control={form.control}
              name={fieldName}
              render={({ field }) => (
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={field.value ?? "#000000"}
                    onChange={(e) => {
                      field.onChange(e.target.value);
                      onFieldChange();
                    }}
                    onBlur={() => {
                      field.onBlur();
                      onFieldCommit();
                    }}
                    className="h-9 w-9 shrink-0 cursor-pointer rounded-lg border border-border bg-transparent p-0.5"
                  />
                  <Input
                    value={field.value ?? ""}
                    onChange={(e) => {
                      field.onChange(e.target.value);
                      onFieldChange();
                    }}
                    onBlur={() => {
                      field.onBlur();
                      onFieldCommit();
                    }}
                    placeholder="#000000"
                    className="w-28"
                  />
                  <span className="flex-1 text-xs text-muted-foreground">
                    {label}
                  </span>
                </div>
              )}
            />
          );
        })}
      </div>
    </BrandCard>
  );
}
