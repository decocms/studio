import { Page } from "@/web/components/page";
import { ObservationalAgentSection } from "@/web/views/settings/observational-agent-section";

export function OrgObservationPage() {
  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <div className="flex flex-col gap-6">
            <div>
              <Page.Title>Observation</Page.Title>
              <p className="mt-1 text-sm text-muted-foreground">
                Run chosen agents over idle conversations so they can review
                what's happening and act on it — record memory, flag content,
                summarize, whatever each agent is set up to do.
              </p>
            </div>
            <ObservationalAgentSection />
          </div>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
