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
import RequiredAuthLayout from "@/layouts/required-auth-layout";
import { listOrganizationsCached } from "@/lib/auth-client";
import { readLastLocation } from "@/lib/last-location";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";
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

function lastOrgSlug(): string | null {
  try {
    return (
      readLastLocation()?.org ??
      localStorage.getItem(LOCALSTORAGE_KEYS.lastOrgSlug())
    );
  } catch {
    return null;
  }
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-3 text-center">
        {children}
      </div>
    </div>
  );
}

function ToOrg() {
  const remembered = lastOrgSlug();
  const orgs = useQuery({
    queryKey: KEYS.contentBackend("connect", "organizations"),
    queryFn: listOrganizationsCached,
    enabled: !remembered,
  });
  const org = remembered ?? orgs.data?.data?.[0]?.slug ?? null;
  if (org) {
    return <Navigate to="/$org/connect" params={{ org }} replace />;
  }
  if (orgs.isPending) {
    return (
      <Centered>
        <Spinner className="size-6 text-muted-foreground" />
      </Centered>
    );
  }
  return <Navigate to="/" replace />;
}

export default function ConnectRoute() {
  const t = useT();
  const [hasConnection] = useState(takeConnectionFromUrl);
  if (!hasConnection) {
    return (
      <Centered>
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
