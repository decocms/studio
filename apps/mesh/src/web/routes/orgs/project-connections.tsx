/**
 * Project Connections — /$org/$project/connections
 *
 * Shows connections scoped to this storefront project.
 * Org-level connections: readonly (configured in Studio).
 * Personal connections: user-level, connectable here.
 */
import { Page } from "@/web/components/page";
import { Check, Loading01 } from "@untitledui/icons";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@deco/ui/components/breadcrumb.tsx";
import { useState } from "react";

const ORG_CONNECTIONS = [
  {
    id: "github",
    name: "GitHub",
    description: "Content versioning & publishing",
    iconUrl: "https://www.google.com/s2/favicons?domain=github.com&sz=32",
    connectedBy: "Rafael Valls",
    usedBy: ["Blog Post Generator"],
    connected: true,
  },
  {
    id: "shopify",
    name: "Shopify",
    description: "Product catalog & store data",
    iconUrl: "https://www.google.com/s2/favicons?domain=shopify.com&sz=32",
    connectedBy: "Rafael Valls",
    usedBy: ["Blog Post Generator", "Catalog Manager"],
    connected: true,
  },
  {
    id: "gsc",
    name: "Google Search Console",
    description: "Keyword data & search performance",
    iconUrl:
      "https://www.google.com/s2/favicons?domain=search.google.com&sz=32",
    connectedBy: null,
    usedBy: ["SEO Optimizer", "Blog Post Generator"],
    connected: false,
  },
  {
    id: "ga",
    name: "Google Analytics",
    description: "Traffic & conversion analytics",
    iconUrl:
      "https://www.google.com/s2/favicons?domain=analytics.google.com&sz=32",
    connectedBy: null,
    usedBy: ["Performance Monitor", "Conversion Analyst"],
    connected: false,
  },
];

const PERSONAL_CONNECTIONS = [
  {
    id: "gmail",
    name: "Gmail",
    description: "Email notifications & reports",
    iconUrl: "https://www.google.com/s2/favicons?domain=gmail.com&sz=32",
  },
  {
    id: "gcal",
    name: "Google Calendar",
    description: "Schedule agent run times",
    iconUrl:
      "https://www.google.com/s2/favicons?domain=calendar.google.com&sz=32",
  },
  {
    id: "slack",
    name: "Slack",
    description: "Receive alerts & task approvals",
    iconUrl: "https://www.google.com/s2/favicons?domain=slack.com&sz=32",
  },
];

function ProjectConnectionsContent() {
  const [connectedOrg, setConnectedOrg] = useState<Set<string>>(
    new Set(ORG_CONNECTIONS.filter((c) => c.connected).map((c) => c.id)),
  );
  const [connectedPersonal, setConnectedPersonal] = useState<Set<string>>(
    new Set(),
  );
  const [connecting, setConnecting] = useState<Set<string>>(new Set());

  function handleConnect(id: string, type: "org" | "personal") {
    setConnecting((prev) => new Set(prev).add(id));
    setTimeout(() => {
      setConnecting((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      if (type === "org") {
        setConnectedOrg((prev) => new Set(prev).add(id));
      } else {
        setConnectedPersonal((prev) => new Set(prev).add(id));
      }
    }, 800);
  }

  return (
    <Page>
      <Page.Header>
        <Page.Header.Left>
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>Connections</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </Page.Header.Left>
      </Page.Header>

      <Page.Content>
        <div className="max-w-3xl mx-auto px-6 py-8 flex flex-col gap-8">
          {/* Organization connections */}
          <div>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-sm font-semibold text-foreground">
                  Organization
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Managed in Studio. Used by agents in this project.
                </p>
              </div>
              <Button variant="outline" size="sm">
                Manage in Studio
              </Button>
            </div>

            <div className="flex flex-col gap-2">
              {ORG_CONNECTIONS.map((conn) => {
                const isConnected = connectedOrg.has(conn.id);
                const isConnecting = connecting.has(conn.id);
                return (
                  <div
                    key={conn.id}
                    className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3"
                  >
                    <img
                      src={conn.iconUrl}
                      alt={conn.name}
                      className="size-8 rounded-lg"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-foreground">
                          {conn.name}
                        </p>
                        <Badge
                          variant="secondary"
                          className="text-[10px] px-1.5 py-0 h-4"
                        >
                          Org
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {conn.description}
                      </p>
                      {conn.usedBy.length > 0 && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Used by: {conn.usedBy.join(", ")}
                        </p>
                      )}
                    </div>
                    {isConnected ? (
                      <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 shrink-0">
                        <Check size={12} />
                        Connected
                        {conn.connectedBy && ` · ${conn.connectedBy}`}
                      </div>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={isConnecting}
                        onClick={() => handleConnect(conn.id, "org")}
                        className="shrink-0"
                      >
                        {isConnecting ? (
                          <Loading01 size={14} className="animate-spin" />
                        ) : null}
                        {isConnecting ? "Connecting..." : "Connect"}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Personal connections */}
          <div>
            <div className="mb-4">
              <h2 className="text-sm font-semibold text-foreground">
                Personal
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Your private connections — only you can see these.
              </p>
            </div>

            <div className="flex flex-col gap-2">
              {PERSONAL_CONNECTIONS.map((conn) => {
                const isConnected = connectedPersonal.has(conn.id);
                const isConnecting = connecting.has(conn.id);

                return (
                  <div
                    key={conn.id}
                    className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3"
                  >
                    <img
                      src={conn.iconUrl}
                      alt={conn.name}
                      className="size-8 rounded-lg"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground">
                        {conn.name}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {conn.description}
                      </p>
                    </div>
                    {isConnected ? (
                      <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 shrink-0">
                        <Check size={12} />
                        Connected
                      </div>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={isConnecting}
                        onClick={() => handleConnect(conn.id, "personal")}
                        className="shrink-0"
                      >
                        {isConnecting ? (
                          <Loading01 size={14} className="animate-spin" />
                        ) : null}
                        {isConnecting ? "Connecting..." : "Connect"}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </Page.Content>
    </Page>
  );
}

export default function ProjectConnections() {
  return <ProjectConnectionsContent />;
}
