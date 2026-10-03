/**
 * `/connect#endpoint=…&token=…` — the link `deco serve` prints.
 *
 * Takes the connection out of the fragment (so the token never stays in the
 * address bar or history), holds it for this tab and hands over to the org's
 * connect screen, which picks the project. The fragment doesn't survive the
 * login redirect, which is why it's stashed before the auth gate.
 */

import { useState } from "react";
import { Navigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import {
  parseConnectFragment,
  readPendingConnection,
  stashPendingConnection,
} from "@/components/sections-editor/deco-serve-connection";
import { ConnectCentered as Centered } from "@/components/sections-editor/deco-serve-chip";
import RequiredAuthLayout from "@/layouts/required-auth-layout";
import { resolveDefaultOrgSlug } from "@/lib/default-org";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";

function takeConnectionFromUrl(): boolean {
  const connection = parseConnectFragment(window.location.hash);
  if (connection) {
    stashPendingConnection(connection);
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
  }
  return readPendingConnection() !== null;
}

/** Hands over to the default org's connect screen once signed in. */
function ToOrg() {
  const target = useQuery({
    queryKey: KEYS.defaultOrgSlug(),
    queryFn: async () => ({ org: await resolveDefaultOrgSlug() }),
  });
  if (target.isPending) {
    return (
      <Centered fullScreen>
        <Spinner className="size-6 text-muted-foreground" />
      </Centered>
    );
  }
  const org = target.data?.org;
  return org ? (
    <Navigate to="/$org/connect" params={{ org }} replace />
  ) : (
    <Navigate to="/" replace />
  );
}

export default function ConnectRoute() {
  const t = useT();
  const [hasConnection] = useState(takeConnectionFromUrl);
  if (!hasConnection) {
    return (
      <Centered fullScreen>
        <h1 className="text-lg font-medium text-foreground">
          {t("decoServe.connect.invalidLinkTitle")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("decoServe.connect.invalidLinkDescription")}
        </p>
      </Centered>
    );
  }
  return (
    <RequiredAuthLayout>
      <ToOrg />
    </RequiredAuthLayout>
  );
}
