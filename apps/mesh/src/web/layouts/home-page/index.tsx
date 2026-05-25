import { Chat } from "@/web/components/chat";
import { NoAiProviderEmptyState } from "@/web/components/chat/no-ai-provider-empty-state";
import { useAiProviderKeys } from "@/web/hooks/collections/use-ai-providers";
import { useCurrentLink } from "@/web/hooks/use-current-link";
import { useDecoCredits } from "@/web/hooks/use-deco-credits";
import { authClient } from "@/web/lib/auth-client";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { HomeBackground } from "./background";

export function HomePage() {
  const { data: session } = authClient.useSession();
  const isMobile = useIsMobile();
  const allKeys = useAiProviderKeys();
  const link = useCurrentLink();
  const {
    hasDecoKey,
    isZeroBalance,
    isInitialFreeCredit,
    balanceDollars,
    hasOnlyDecoProvider,
  } = useDecoCredits();

  if (allKeys.length === 0 && !link.online) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="min-h-full flex items-center justify-center px-4 py-10">
          <NoAiProviderEmptyState />
        </div>
      </div>
    );
  }

  const userName = session?.user?.name?.split(" ")[0] || "there";
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
      </div>
    );
  }

  return (
    <div className="flex-1 relative flex flex-col min-h-0">
      <HomeBackground />
      <div className="flex-1 relative flex flex-col overflow-y-auto">
        <div className="relative flex flex-col items-center px-10 pb-4 flex-1 justify-center">
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
      </div>
    </div>
  );
}

function Capybara() {
  return (
    <img
      src="/home/capybara.png"
      alt=""
      aria-hidden
      className="pointer-events-none absolute -top-10 right-6 z-20 h-12 w-auto select-none"
    />
  );
}
