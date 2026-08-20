import { ProjectContextProvider } from "@/sdk";
import { ReviewSettings } from "@/components/settings/review-settings";
import { RepoReviewSettings } from "@/components/settings/repo-review-settings";

/**
 * QA harness (local, not committed): the real "Reviewers & merge" settings
 * area, mounted with a real ProjectContext. All data flows over the app's real
 * `POST /api/:org/tools/:name` fetch, which the test intercepts.
 */
export function SettingsHarness({ perRepo = true }: { perRepo?: boolean }) {
  return (
    <ProjectContextProvider
      org={{ id: "org_qa", slug: "qa-org", name: "QA Org" } as never}
      project={{ id: "proj_qa", slug: "default" } as never}
    >
      <div className="p-6 bg-background max-w-5xl">
        <ReviewSettings />
        {perRepo ? <RepoReviewSettings /> : null}
      </div>
    </ProjectContextProvider>
  );
}
