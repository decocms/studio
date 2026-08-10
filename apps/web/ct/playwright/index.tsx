import { beforeMount } from "@playwright/experimental-ct-react/hooks";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@decocms/ui/components/tooltip.tsx";
import "./index.css";

// One client per page load; retries off so failed (stubbed) queries settle fast.
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

beforeMount(async ({ App }) => {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={0}>
        <App />
      </TooltipProvider>
    </QueryClientProvider>
  );
});
