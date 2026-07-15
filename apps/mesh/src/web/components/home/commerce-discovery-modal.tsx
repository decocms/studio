/**
 * Commerce discovery modal for the demo home.
 *
 * Desktop: a large centered split modal (login-page style) — the left half is
 * a compact list of connectable data sources, the right half is the "schedule
 * a call" card reused from the commerce onboarding flow.
 *
 * Mobile: a bottom drawer with the same list plus the compact "schedule a
 * call" banner above the CTA.
 *
 * No real API calls — connect state is local for the demo.
 */
import { useState, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
} from "@deco/ui/components/drawer.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { cn } from "@deco/ui/lib/utils.ts";
import { ArrowRight, Check } from "@untitledui/icons";
import { IntegrationIcon } from "@/web/components/integration-icon";
import {
  ScheduleMeetingBanner,
  ScheduleMeetingVisual,
} from "@/web/routes/commerce-onboarding/schedule-meeting";

interface MockIntegration {
  key: string;
  area: string;
  name: string;
  headline: string;
  icon: string;
}

const MOCK_INTEGRATIONS: MockIntegration[] = [
  {
    key: "vtex",
    area: "Catálogo",
    name: "VTEX",
    headline: "Rupturas e PDPs que travam suas vendas.",
    icon: "https://cdn.simpleicons.org/vtex/F71963",
  },
  {
    key: "shopify",
    area: "Catálogo",
    name: "Shopify",
    headline: "Estoque, pedidos e produtos da sua loja.",
    icon: "https://cdn.simpleicons.org/shopify/95BF47",
  },
  {
    key: "google-analytics",
    area: "Funil",
    name: "Google Analytics",
    headline: "Onde a receita vaza no seu funil.",
    icon: "https://cdn.simpleicons.org/googleanalytics/E37400",
  },
  {
    key: "google-search-console",
    area: "Busca",
    name: "Search Console",
    headline: "O tráfego de busca que você deixa na mesa.",
    icon: "https://cdn.simpleicons.org/googlesearchconsole/458CF5",
  },
  {
    key: "github",
    area: "Engenharia",
    name: "GitHub",
    headline: "A saúde da entrega de código por trás da sua loja.",
    icon: "https://cdn.simpleicons.org/github/888888",
  },
];

function IntegrationRow({
  integration,
  isConnected,
  onToggle,
}: {
  integration: MockIntegration;
  isConnected: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3.5 rounded-xl border p-3 transition-colors",
        isConnected
          ? "border-success/50 bg-success/5"
          : "border-border bg-card hover:border-foreground/20",
      )}
    >
      <IntegrationIcon
        icon={integration.icon}
        name={integration.name}
        size="md"
        fit="contain"
        className="p-2.5"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {integration.name}
          </span>
          <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[11px] font-medium text-muted-foreground">
            {integration.area}
          </span>
        </div>
        <span className="truncate text-xs leading-4 text-muted-foreground">
          {integration.headline}
        </span>
      </div>
      <Button
        size="sm"
        variant={isConnected ? "outline" : "default"}
        className={cn("shrink-0", isConnected && "text-success")}
        onClick={onToggle}
      >
        {isConnected ? (
          <>
            <Check className="size-4" />
            Conectado
          </>
        ) : (
          "Conectar"
        )}
      </Button>
    </div>
  );
}

function ConnectionsPanel({
  title,
  connected,
  onToggle,
  onClose,
  footerExtra,
}: {
  /** The dialog/drawer title primitive, wired for accessibility. */
  title: ReactNode;
  connected: Set<string>;
  onToggle: (key: string) => void;
  onClose: () => void;
  /** Optional node rendered just above the CTA (mobile schedule banner). */
  footerExtra?: ReactNode;
}) {
  const connectedCount = connected.size;
  const total = MOCK_INTEGRATIONS.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 p-6 md:p-8">
      <div className="grid gap-1.5 pr-8">
        {title}
        <p className="text-sm leading-5 text-muted-foreground">
          Conecte suas fontes de dados para ver o diagnóstico completo da sua
          loja.{" "}
          {connectedCount > 0 && (
            <span className="font-medium text-foreground">
              {connectedCount} de {total} conectadas.
            </span>
          )}
        </p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto">
        {MOCK_INTEGRATIONS.map((integration) => (
          <IntegrationRow
            key={integration.key}
            integration={integration}
            isConnected={connected.has(integration.key)}
            onToggle={() => onToggle(integration.key)}
          />
        ))}
      </div>

      <div className="flex shrink-0 flex-col gap-3">
        {footerExtra}
        <Button
          size="xl"
          className="w-full rounded-2xl text-base font-medium"
          onClick={onClose}
          disabled={connectedCount === 0}
        >
          Ver relatório completo
          <ArrowRight size={18} />
        </Button>
      </div>
    </div>
  );
}

export function CommerceDiscoveryModal({ onClose }: { onClose: () => void }) {
  const isMobile = useIsMobile();
  const [connected, setConnected] = useState<Set<string>>(new Set());

  const toggle = (key: string) => {
    setConnected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (isMobile) {
    return (
      <Drawer open onOpenChange={(open) => !open && onClose()}>
        <DrawerContent
          className="max-h-[92vh]"
          overlayClassName="backdrop-blur-sm"
        >
          <ConnectionsPanel
            title={
              <DrawerTitle className="text-2xl font-medium leading-8">
                Conecte suas ferramentas
              </DrawerTitle>
            }
            connected={connected}
            onToggle={toggle}
            onClose={onClose}
            footerExtra={<ScheduleMeetingBanner />}
          />
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-h-[88vh] max-w-[1120px] gap-0 overflow-hidden p-0 sm:max-w-[1120px]"
        closeButtonClassName="z-10"
        overlayClassName="backdrop-blur-sm"
      >
        <div className="flex">
          {/* Left — connection list */}
          <ConnectionsPanel
            title={
              <DialogTitle className="text-2xl font-medium leading-8">
                Conecte suas ferramentas
              </DialogTitle>
            }
            connected={connected}
            onToggle={toggle}
            onClose={onClose}
          />

          {/* Right — schedule a call card */}
          <aside className="flex w-[420px] shrink-0 items-center justify-center border-l border-border bg-sidebar">
            <ScheduleMeetingVisual />
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  );
}
