import { Suspense } from "react";
import { Zap } from "@untitledui/icons";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { ProviderCardGrid } from "@/web/views/settings/org-ai-providers";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useAuthConfig } from "@/web/providers/auth-config-provider";
import { KEYS } from "@/web/lib/query-keys";
import { unwrapToolResult } from "@/web/lib/unwrap-tool-result";
import { useQuery } from "@tanstack/react-query";
import type { BrandContext } from "@/storage/types";

interface NoAiProviderEmptyStateProps {
  title?: string;
  description?: string;
}

function useDefaultBrand(): BrandContext | null {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const { data } = useQuery<BrandContext | null>({
    queryKey: KEYS.defaultBrand(org.id),
    queryFn: async () => {
      const result = await client.callTool({
        name: "BRAND_CONTEXT_LIST",
        arguments: {},
      });
      const data = unwrapToolResult<{ items?: BrandContext[] }>(result);
      const brands = Array.isArray(data?.items) ? data.items : [];
      return brands.find((b) => b.isDefault && !b.archivedAt) ?? null;
    },
  });

  return data ?? null;
}

function extractPrimaryColor(brand: BrandContext): string | null {
  const colors = brand.colors;
  if (!colors) return null;

  if (Array.isArray(colors)) {
    const entry = colors.find(
      (c) =>
        typeof c === "object" &&
        c !== null &&
        "label" in c &&
        /primary|brand|main/i.test((c as { label: string }).label),
    );
    const val = entry
      ? (entry as { value?: string }).value
      : (colors[0] as { value?: string })?.value;
    return typeof val === "string" ? val : null;
  }

  if (typeof colors === "object") {
    const rec = colors as Record<string, string>;
    return rec.primary ?? Object.values(rec)[0] ?? null;
  }

  return null;
}

export function NoAiProviderEmptyState({
  title,
  description,
}: NoAiProviderEmptyStateProps = {}) {
  const { org } = useProjectContext();
  const { localMode } = useAuthConfig();
  const brand = useDefaultBrand();

  const orgName = org.name;
  const primaryColor = brand ? extractPrimaryColor(brand) : null;
  const brandIcon = brand?.favicon ?? brand?.logo ?? null;

  const heading =
    title ??
    (orgName
      ? `${orgName} is ready for agents`
      : "Your agents are almost ready");
  const subtitle = description ?? "Choose how to power your AI team.";

  // Badge styles: use brand color if available, otherwise lime gradient
  const hasBrandStyle = !!(brandIcon || primaryColor);
  const badgeStyle = primaryColor
    ? {
        backgroundColor: `${primaryColor}18`,
        borderColor: `${primaryColor}30`,
      }
    : undefined;
  const badgeClass = hasBrandStyle
    ? "flex items-center justify-center size-14 rounded-2xl border"
    : "flex items-center justify-center size-14 rounded-2xl bg-gradient-to-br from-lime-100 to-yellow-50 dark:from-lime-900/30 dark:to-yellow-900/20 border border-lime-300/40 dark:border-lime-700/30";

  return (
    <div className="flex flex-col items-center gap-8 w-full max-w-2xl px-4">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className={badgeClass} style={badgeStyle}>
          {brandIcon ? (
            <img
              src={brandIcon}
              alt=""
              className="size-7 rounded object-contain"
            />
          ) : (
            <Zap
              size={24}
              style={primaryColor ? { color: primaryColor } : undefined}
              className={cn(
                !primaryColor && "text-lime-600 dark:text-lime-400",
              )}
            />
          )}
        </div>
        <div className="space-y-2">
          <p className="text-xl font-semibold text-foreground tracking-tight">
            {heading}
          </p>
          <p className="text-sm text-muted-foreground max-w-md">{subtitle}</p>
        </div>
      </div>

      <div className="w-full space-y-3">
        {localMode && (
          <p className="text-xs text-muted-foreground text-center">
            Local models + use your existing AI provider
          </p>
        )}
        <Suspense
          fallback={
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 w-full">
              <Skeleton className="h-32 w-full rounded-lg" />
              <Skeleton className="h-32 w-full rounded-lg" />
            </div>
          }
        >
          <ProviderCardGrid />
        </Suspense>
      </div>
    </div>
  );
}
