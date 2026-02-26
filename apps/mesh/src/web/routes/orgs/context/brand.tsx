/**
 * Brand context page — /$org/$project/brand
 *
 * Shows brand description, colors, tech stack, traffic stats, and an Agent Monitor card.
 */

import { Page } from "@/web/components/page";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@deco/ui/components/breadcrumb.tsx";
import { Edit01, FaceSmile } from "@untitledui/icons";

// ─── Data ─────────────────────────────────────────────────────────────────────

const BRAND = {
  description:
    "Brazilian fashion brand known for bold tropical prints and sustainable sourcing. Direct-to-consumer e-commerce with strong presence across Brazil, US, and Europe. Seasonal collections averaging 200+ SKUs.",
  colors: ["#1B5E20", "#F4E9D1", "#C8102E", "#2C2C2C"],
  techStack: [
    "VTEX",
    "Google Tag Manager",
    "Hotjar",
    "TrustVox",
    "Zendesk Chat",
    "Facebook Pixel",
    "Google Ads",
  ],
  traffic: {
    monthly: "2.1M",
    duration: "3m 42s",
    bounce: "41%",
    pagesPerVisit: "4.2",
  },
};

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function BrandPage() {
  return (
    <Page>
      <Page.Header>
        <Page.Header.Left>
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <span className="text-sm text-muted-foreground">Context</span>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>Brand</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </Page.Header.Left>
        <Page.Header.Right>
          <span className="text-xs text-muted-foreground">
            Last checked 2h ago
          </span>
          <Button variant="outline" size="sm" className="h-7 text-xs">
            Run check
          </Button>
        </Page.Header.Right>
      </Page.Header>

      <Page.Content className="h-full overflow-y-auto">
        <div className="max-w-5xl mx-auto px-6 py-8 grid grid-cols-[1fr_280px] gap-8">
          {/* Left column */}
          <div className="flex flex-col gap-6">
            {/* Description */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-1.5">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Brand Description
                </p>
                <Edit01 size={12} className="text-muted-foreground/60" />
              </div>
              <p
                contentEditable
                suppressContentEditableWarning
                className="text-sm text-foreground leading-relaxed rounded-lg border border-transparent px-3 py-2 -mx-3 outline-none focus:border-border focus:bg-background transition-colors"
              >
                {BRAND.description}
              </p>
            </div>

            {/* Brand colors */}
            <div className="flex flex-col gap-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Brand Colors
              </p>
              <div className="flex gap-3">
                {BRAND.colors.map((color) => (
                  <div key={color} className="flex flex-col items-center gap-1">
                    <div
                      className="size-10 rounded-xl border border-border shadow-sm"
                      style={{ backgroundColor: color }}
                    />
                    <span className="text-[10px] font-mono text-muted-foreground">
                      {color}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Tech stack */}
            <div className="flex flex-col gap-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Tech Stack
              </p>
              <div className="flex flex-wrap gap-1.5">
                {BRAND.techStack.map((t) => (
                  <span
                    key={t}
                    className="rounded-md border border-border bg-muted px-2 py-1 text-xs font-medium"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>

            {/* Traffic stats */}
            <div className="flex flex-col gap-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Traffic
              </p>
              <div className="grid grid-cols-4 gap-3">
                {[
                  { label: "Monthly visits", value: BRAND.traffic.monthly },
                  { label: "Avg. duration", value: BRAND.traffic.duration },
                  { label: "Bounce rate", value: BRAND.traffic.bounce },
                  {
                    label: "Pages/visit",
                    value: BRAND.traffic.pagesPerVisit,
                  },
                ].map(({ label, value }) => (
                  <div
                    key={label}
                    className="rounded-lg border border-border bg-muted/50 p-3"
                  >
                    <p className="text-xs text-muted-foreground">{label}</p>
                    <p className="text-lg font-semibold mt-0.5">{value}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right column */}
          <div className="flex flex-col gap-4">
            {/* Agent Monitor card — placeholder */}
            <div className="rounded-xl border border-border p-4 flex flex-col gap-3">
              <div className="flex items-start gap-3">
                <div className="size-9 rounded-lg bg-pink-100 text-pink-600 flex items-center justify-center shrink-0">
                  <FaceSmile size={17} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold">Brand Monitor</p>
                  <p className="text-xs text-muted-foreground">No agent yet</p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                No agent is currently monitoring your brand. An agent could
                track brand mentions, flag tone inconsistencies, and keep your
                brand profile up to date.
              </p>
              <div className="rounded-lg border border-border/60 bg-muted/40 px-3 py-2">
                <p className="text-xs text-muted-foreground text-center">
                  Coming soon
                </p>
              </div>
            </div>

            {/* Reports timeline — empty */}
            <div className="flex flex-col gap-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Recent reports
              </p>
              <p className="text-xs text-muted-foreground">
                No reports yet. Hire an agent to start monitoring.
              </p>
            </div>
          </div>
        </div>
      </Page.Content>
    </Page>
  );
}
