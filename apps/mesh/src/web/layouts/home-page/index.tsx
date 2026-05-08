import { AgentsList } from "@/web/components/home/agents-list.tsx";
import { Chat } from "@/web/components/chat";
import { ImportFromDecoDialog } from "@/web/components/import-from-deco-dialog.tsx";
import { IntegrationIcon } from "@/web/components/integration-icon";
import { authClient } from "@/web/lib/auth-client";
import { KEYS } from "@/web/lib/query-keys";
import { useDecoCredits } from "@/web/hooks/use-deco-credits";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { ArrowRight } from "@untitledui/icons";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

const DECO_BANNER_GRADIENT = [
  "radial-gradient(ellipse 25% 220% at -5% 120%, rgba(165,149,255,0.35) 0%, transparent 100%)",
  "radial-gradient(ellipse 25% 220% at 105% -20%, rgba(208,236,26,0.32) 0%, transparent 100%)",
].join(", ");
const DECO_BANNER_TEXTURE = "/decotexture.svg";

function ImportDecoSiteBanner({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full relative flex items-center gap-4 px-4 py-4 rounded-lg border border-border bg-background overflow-hidden transition-colors text-left cursor-pointer group"
      style={{ backgroundImage: DECO_BANNER_GRADIENT }}
    >
      <div className="relative shrink-0 p-1.5 bg-[var(--brand-green-light)] rounded-lg border border-border">
        <IntegrationIcon
          icon="/logos/deco%20logo.svg"
          name="deco.cx"
          size="xs"
          className="border-0 rounded-none bg-transparent"
        />
      </div>
      <p className="flex-1 relative text-sm font-medium text-foreground leading-none whitespace-nowrap">
        Import your deco.cx site
      </p>
      <img
        src={DECO_BANNER_TEXTURE}
        alt=""
        aria-hidden
        className="absolute pointer-events-none"
        style={{
          width: "274.5px",
          height: "272.25px",
          left: "calc(50% + 145.5px)",
          top: "calc(50% + 40px)",
          transform: "translate(-50%, -50%)",
        }}
      />
      <div className="relative bg-background flex items-center justify-center size-8 rounded-md shrink-0">
        <ArrowRight
          size={16}
          className="text-foreground transition-transform group-hover:translate-x-0.5"
        />
      </div>
    </button>
  );
}

function useIsDecoUser() {
  const { data: session } = authClient.useSession();
  const { data } = useQuery({
    queryKey: KEYS.decoProfile(session?.user?.email),
    queryFn: async () => {
      const res = await fetch("/api/deco-sites/profile");
      if (!res.ok) return { isDecoUser: false };
      return res.json() as Promise<{ isDecoUser: boolean }>;
    },
    enabled: Boolean(session?.user?.email),
    staleTime: 5 * 60_000,
  });
  return data?.isDecoUser ?? false;
}

export function HomePage() {
  const { data: session } = authClient.useSession();
  const [importOpen, setImportOpen] = useState(false);
  const isDecoUser = useIsDecoUser();
  const isMobile = useIsMobile();
  const {
    hasDecoKey,
    isZeroBalance,
    isInitialFreeCredit,
    balanceDollars,
    hasOnlyDecoProvider,
  } = useDecoCredits();

  const userName = session?.user?.name?.split(" ")[0] || "there";

  const showEyebrow =
    hasDecoKey && isInitialFreeCredit && balanceDollars != null;
  const showNoCreditsEyebrow =
    hasDecoKey && isZeroBalance && hasOnlyDecoProvider;

  if (isMobile) {
    return (
      <>
        <div className="flex-1 relative flex flex-col items-center px-4">
          <div className="flex-1 flex flex-col items-center justify-center w-full">
            {showEyebrow && (
              <div className="mb-4">
                <Chat.CreditsEyebrow balanceDollars={balanceDollars} />
              </div>
            )}
            {showNoCreditsEyebrow && (
              <div className="mb-4">
                <Chat.NoCreditsEyebrow />
              </div>
            )}
            <p className="text-3xl font-medium text-foreground text-center max-w-[280px]">
              What's on your mind, {userName}?
            </p>
          </div>
          <div className="w-full flex flex-col gap-4 pb-4">
            <AgentsList />
            <Chat.Input showConnectionsBanner />
          </div>
          {isDecoUser && (
            <div className="w-full">
              <ImportDecoSiteBanner onClick={() => setImportOpen(true)} />
            </div>
          )}
        </div>
        <ImportFromDecoDialog open={importOpen} onOpenChange={setImportOpen} />
      </>
    );
  }

  return (
    <>
      <div className="flex-1 relative flex flex-col items-center px-10">
        <div className="flex-1 flex flex-col items-center justify-center w-full">
          <div className="flex flex-col items-center w-full max-w-[672px]">
            <div className="text-center mb-10">
              {showEyebrow && (
                <div className="mb-4">
                  <Chat.CreditsEyebrow balanceDollars={balanceDollars} />
                </div>
              )}
              {showNoCreditsEyebrow && (
                <div className="mb-4">
                  <Chat.NoCreditsEyebrow />
                </div>
              )}
              <p className="text-3xl font-medium text-foreground">
                What's on your mind, {userName}?
              </p>
            </div>
            <div className="w-full">
              <Chat.Input showConnectionsBanner />
            </div>
          </div>
          <div className="w-full mt-10 mx-auto">
            <AgentsList />
          </div>
        </div>
        {isDecoUser && (
          <div className="absolute bottom-6 left-0 right-0 px-10">
            <div className="w-full max-w-[500px] mx-auto">
              <ImportDecoSiteBanner onClick={() => setImportOpen(true)} />
            </div>
          </div>
        )}
      </div>
      <ImportFromDecoDialog open={importOpen} onOpenChange={setImportOpen} />
    </>
  );
}
