import type { ReactNode } from "react";
import { Panel } from "@/components/panel";
import { Page } from "@/components/page";

/** Detail views contribute to the surrounding page instead of nesting a second header. */
export function DetailPanel({
  children,
  leading,
}: {
  children: ReactNode;
  leading?: ReactNode;
}) {
  return (
    <Page>
      {leading && (
        <Panel.Toolbar.Left.Portal fallback={leading}>
          {leading}
        </Panel.Toolbar.Left.Portal>
      )}
      <Page.Content>{children}</Page.Content>
    </Page>
  );
}
