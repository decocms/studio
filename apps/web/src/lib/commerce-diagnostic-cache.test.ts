import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { refreshCommerceDiagnosticOwnership } from "./commerce-diagnostic-cache";
import { KEYS } from "./query-keys";

describe("refreshCommerceDiagnosticOwnership", () => {
  test("drops every old owner diagnostic and invalidates connection metadata", async () => {
    const queryClient = new QueryClient();
    const organizationId = "org_1";
    const connectionId = "conn_1";
    const connectionKey = KEYS.commerceDiscoveryConnection(
      organizationId,
      connectionId,
    );
    const orgDiagnosticKey = KEYS.commerceDiscoveryDiagnostic(
      organizationId,
      connectionId,
    );
    const firstProjectKey = KEYS.commerceDiscoveryDiagnostic(
      organizationId,
      connectionId,
      "vir_1",
    );
    const secondProjectKey = KEYS.commerceDiscoveryDiagnostic(
      organizationId,
      connectionId,
      "vir_2",
    );
    const otherOrgKey = KEYS.commerceDiscoveryDiagnostic(
      "org_2",
      "conn_2",
      "vir_3",
    );

    queryClient.setQueryData(connectionKey, { item: { id: connectionId } });
    queryClient.setQueryData(orgDiagnosticKey, { scanned_at: "old" });
    queryClient.setQueryData(firstProjectKey, { scanned_at: "old" });
    queryClient.setQueryData(secondProjectKey, { scanned_at: "old" });
    queryClient.setQueryData(otherOrgKey, { scanned_at: "keep" });

    await refreshCommerceDiagnosticOwnership(
      queryClient,
      organizationId,
      connectionId,
    );

    expect(queryClient.getQueryData(orgDiagnosticKey)).toBeUndefined();
    expect(queryClient.getQueryData(firstProjectKey)).toBeUndefined();
    expect(queryClient.getQueryData(secondProjectKey)).toBeUndefined();
    expect(
      queryClient.getQueryData<{ scanned_at: string }>(otherOrgKey),
    ).toEqual({
      scanned_at: "keep",
    });
    expect(queryClient.getQueryState(connectionKey)?.isInvalidated).toBe(true);
  });
});
