import { useEffect } from "react";
import { AuthSplitLayout } from "@/web/components/auth-split-layout";
import { authClient } from "@/web/lib/auth-client";

/**
 * Landing page after the CLI's OAuth flow completes. The CLI's localhost
 * callback server 302-redirects the browser here. We read the freshly
 * established session to personalize the message, and silently attempt
 * to close the tab (browsers block this for non-JS-opened tabs, which is
 * fine — the page itself is the fallback).
 */
export default function CliAuthSuccessRoute() {
  const session = authClient.useSession();
  const email = session.data?.user?.email;

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    window.close();
  }, []);

  return (
    <AuthSplitLayout>
      <div className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">
          You're logged in{email ? <> as {email}</> : ""}.
        </h1>
        <p className="text-muted-foreground">
          You can return to your terminal.
        </p>
      </div>
    </AuthSplitLayout>
  );
}
