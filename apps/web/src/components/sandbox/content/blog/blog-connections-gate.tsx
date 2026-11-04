/**
 * Stands in for the blog's content until the organization's VTEX and GA4
 * connections are ready, and says which one is missing and how to fix it.
 */

import type { ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@decocms/ui/components/button.tsx";
import { CheckCircle, AlertCircle } from "@untitledui/icons";
import type {
  BlogConnectionGap,
  BlogConnectionKind,
} from "@decocms/shared/blog-connections";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/use-t.ts";
import { useProjectContext } from "@/sdk";
import { useBlogConnections } from "./use-blog-connections";

const NAME = {
  vtex: "sandbox.blogConnections.vtex",
  ga4: "sandbox.blogConnections.ga4",
} as const satisfies Record<BlogConnectionKind, TranslationKey>;

const GAP = {
  missing: "sandbox.blogConnections.missing",
  inactive: "sandbox.blogConnections.inactive",
  unconfigured: "sandbox.blogConnections.unconfigured",
  unauthorized: "sandbox.blogConnections.unauthorized",
} as const satisfies Record<BlogConnectionGap, TranslationKey>;

export function BlogConnectionsGate({ children }: { children: ReactNode }) {
  const t = useT();
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const connections = useBlogConnections();
  if (connections.ready) return <>{children}</>;
  if (!connections.settled) return null;

  const open = (slug: string | null) =>
    slug
      ? navigate({
          to: "/$org/settings/connections/$appSlug",
          params: { org: org.slug, appSlug: slug },
        })
      : navigate({
          to: "/$org/settings/connections",
          params: { org: org.slug },
          search: { tab: "all" as const },
        });

  return (
    <section className="flex flex-col gap-4 rounded-2xl bg-muted/50 p-6">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium text-foreground">
          {t("sandbox.blogConnections.title")}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t("sandbox.blogConnections.description")}
        </p>
      </div>
      <div className="flex flex-col">
        {(["vtex", "ga4"] as const).map((kind) => {
          const status = connections[kind];
          return (
            <div
              key={kind}
              className="flex h-12 items-center gap-3 border-b border-border/70 last:border-b-0"
            >
              {status.gap ? (
                <AlertCircle size={16} className="shrink-0 text-warning" />
              ) : (
                <CheckCircle size={16} className="shrink-0 text-success" />
              )}
              <span className="w-24 shrink-0 text-sm font-medium text-foreground">
                {t(NAME[kind])}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                {status.gap
                  ? t(GAP[status.gap])
                  : t("sandbox.blogConnections.ready")}
              </span>
              {status.gap && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void open(status.slug)}
                >
                  {t(
                    status.gap === "missing"
                      ? "sandbox.blogConnections.install"
                      : "sandbox.blogConnections.fix",
                  )}
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
