/**
 * One settings section, opened from the index.
 *
 * The header is the task page's breadcrumb, same primitives and same sizing:
 * the trail's leaf names the section, so it also serves as the title, and the
 * parent crumb is the way back. A section has no sibling tabs, so the trail is
 * always two deep — and no blurb, since the fields below say what they are;
 * the one-line summary belongs on the index row that promises the page.
 */

import type { ReactNode } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@decocms/ui/components/breadcrumb.tsx";

export function ProjectSettingsDetail({
  title,
  backLabel,
  onBack,
  actions,
  children,
}: {
  title: string;
  backLabel: string;
  onBack: () => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center justify-between gap-4">
        <Breadcrumb className="-ml-2 min-w-0">
          <BreadcrumbList className="text-[15px]">
            <BreadcrumbItem>
              {/** A button, not an anchor: the index is a search param away,
               *  not a document to link to. */}
              <BreadcrumbLink
                asChild
                className="rounded-md px-2 py-1 text-muted-foreground hover:bg-accent"
              >
                <button type="button" onClick={onBack}>
                  {backLabel}
                </button>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage className="px-2 py-1">{title}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
      {/** Sections breathe like the /settings pages (`SettingsPage`) do. */}
      <div className="flex flex-col gap-10">{children}</div>
    </div>
  );
}
