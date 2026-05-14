/**
 * Home page — chat composer on top, populated tiles below. Each tile
 * appears once the user has started its matching preset task from the
 * side panel.
 */

import { Chat } from "@/web/components/chat";
import { NoAiProviderEmptyState } from "@/web/components/chat/no-ai-provider-empty-state";
import { useAiProviderKeys } from "@/web/hooks/collections/use-ai-providers";
import { authClient } from "@/web/lib/auth-client";
import { useDecoCredits } from "@/web/hooks/use-deco-credits";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { useProjectContext } from "@decocms/mesh-sdk";
import { TileBoard } from "@/web/components/home/tiles/tile-board";
import { useHomeTiles } from "@/web/components/home/tiles/use-home-tiles";
import { HomeBackground } from "./background";

export function HomePage() {
  const { data: session } = authClient.useSession();
  const { org } = useProjectContext();
  const { tiles } = useHomeTiles(org.slug);
  const isMobile = useIsMobile();
  const allKeys = useAiProviderKeys();
  const {
    hasDecoKey,
    isZeroBalance,
    isInitialFreeCredit,
    balanceDollars,
    hasOnlyDecoProvider,
  } = useDecoCredits();

  if (allKeys.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-4 py-10">
        <NoAiProviderEmptyState />
      </div>
    );
  }

  const userName = session?.user?.name?.split(" ")[0] || "there";
  const hasTiles = tiles.length > 0;

  const showEyebrow =
    hasDecoKey && isInitialFreeCredit && balanceDollars != null;
  const showNoCreditsEyebrow =
    hasDecoKey && isZeroBalance && hasOnlyDecoProvider;

  const eyebrow = showEyebrow ? (
    <Chat.CreditsEyebrow balanceDollars={balanceDollars} />
  ) : showNoCreditsEyebrow ? (
    <Chat.NoCreditsEyebrow />
  ) : null;

  if (isMobile) {
    return (
      <div className="flex-1 relative flex flex-col items-center overflow-y-auto">
        <HomeBackground />
        <div className="relative flex flex-col items-center justify-center w-full pt-28 pb-8 px-4">
          {eyebrow && <div className="mb-4">{eyebrow}</div>}
          <p className="text-3xl font-medium text-foreground text-center max-w-[280px]">
            What's on your mind, {userName}?
          </p>
        </div>
        <div className="relative w-full flex flex-col gap-4 pb-8 px-4">
          <Chat.Input showConnectionsBanner />
        </div>
        {hasTiles && (
          <div className="relative w-full px-4 pb-8">
            <TileBoard tiles={tiles} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex-1 relative flex flex-col overflow-y-auto">
      <HomeBackground />
      <div className="relative flex flex-col items-center px-10 pt-32 pb-4">
        <div className="flex flex-col items-center w-full max-w-[672px]">
          <div className="text-center mb-10">
            {eyebrow && <div className="mb-4">{eyebrow}</div>}
            <p className="text-3xl font-medium text-foreground">
              What's on your mind, {userName}?
            </p>
          </div>
          <div className="relative w-full">
            <Capybara />
            <Chat.Input showConnectionsBanner />
          </div>
        </div>
      </div>
      {hasTiles && (
        <div className="relative w-full mt-16 mx-auto max-w-[1080px] px-6 pb-16">
          <TileBoard tiles={tiles} />
        </div>
      )}
    </div>
  );
}

function Capybara() {
  return (
    <img
      src="/home/capybara.png"
      alt=""
      aria-hidden
      className="pointer-events-none absolute -top-7 right-2 h-12 w-auto select-none"
    />
  );
}
