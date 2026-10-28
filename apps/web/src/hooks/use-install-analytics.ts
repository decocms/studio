import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { useT } from "@/i18n/use-t.ts";
import { useProjectContext } from "@/sdk";
import { useStudioTools } from "../lib/studio-tools";

/** Sends adding Deco Analytics to `site`'s code to the Super Agent, which
 *  opens a PR, and opens the card it works on. */
export function useInstallAnalytics() {
  const t = useT();
  const studio = useStudioTools();
  const navigate = useNavigate();
  const { org } = useProjectContext();
  return useMutation({
    mutationFn: (site: string) => studio.call("ANALYTICS_INSTALL", { site }),
    onSuccess: (result) => {
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
