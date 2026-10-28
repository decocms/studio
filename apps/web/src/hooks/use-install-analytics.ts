import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { useT } from "@/i18n/use-t.ts";
import { useProjectContext } from "@/sdk";
import { useStudioTools } from "../lib/studio-tools";

/** Sends adding Deco Analytics to `site`'s code to the Super Agent, which
 *  opens a PR, and opens the card it works on. A `needs_domain` answer is
 *  left to the caller, which asks where the site is live. */
export function useInstallAnalytics() {
  const t = useT();
  const studio = useStudioTools();
  const navigate = useNavigate();
  const { org } = useProjectContext();
  return useMutation({
    mutationFn: (input: { site: string; domain?: string }) =>
      studio.call("ANALYTICS_INSTALL", input),
    onSuccess: (result) => {
      if (result.status === "needs_domain") return;
      if (!result.taskKey) {
        toast.success(t("monitor.analyticsGuide.installSent"));
        return;
      }
      navigate({
        to: "/$org/tasks/{-$taskKey}",
        params: { org: org.slug, taskKey: result.taskKey },
      });
    },
    onError: (error) => toast.error(error.message),
  });
}
