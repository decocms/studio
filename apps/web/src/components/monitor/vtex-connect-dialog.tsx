/**
 * Connecting VTEX from the Monitor: the store's VTEX connection, with the
 * account and app key asked here, and the order ingest bound to it, which is
 * what feeds the Monitor. A VTEX connection the org already has is reused, so
 * only the ingest is added.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "@untitledui/icons";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { PasswordInput } from "@decocms/ui/components/password-input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import type { ConnectionEntity } from "@decocms/shared/sdk/types/connection";
import type { RegistryItem } from "@/components/store/types";
import { fetchOrderMonitorIngestUrl } from "@/hooks/use-order-monitor";
import { useT } from "@/i18n/use-t.ts";
import { authClient } from "@/lib/auth-client";
import { KEYS } from "@/lib/query-keys";
import { callStudioTool } from "@/lib/studio-tools";
import {
  SELF_MCP_ALIAS_ID,
  useCollectionActions,
  useConnections,
  useMCPClient,
  useProjectContext,
} from "@/sdk";
import { extractConnectionData } from "@/utils/extract-connection-data";

const VTEX_APP = "deco/vtex";
/** What the ingest declares: reading its VTEX connection's key from the vault. */
const INGEST_SCOPE = "VTEX::credential:configuration:read";

const isVtex = (c: ConnectionEntity) =>
  c.app_name === "vtex" || c.app_id === VTEX_APP;

const hasKeys = (c: ConnectionEntity | undefined) =>
  !!c?.configuration_state?.accountName &&
  !!c.configuration_state.appKey &&
  !!c.configuration_state.appToken;

/** The ingest's binding to its VTEX connection, as its config form saves it. */
const boundTo = (c: ConnectionEntity) => {
  const binding = c.configuration_state?.VTEX;
  return binding && typeof binding === "object" && "value" in binding
    ? binding.value
    : undefined;
};

type Keys = { accountName: string; appKey: string; appToken: string };

/** The ingest's own error, without the transport's wrapping. */
const reason = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^Streamable HTTP error: Error POSTing to endpoint: /,
    "",
  );

/** VTEX refused the app key: fixed in the dialog, not reported as a dead end. */
class RejectedKeyError extends Error {}

/**
 * Installs the order ingest on a VTEX connection: `vtexId` reuses one,
 * none creates it from the registry; `keys` saves its account and app key.
 */
function useVtexInstall() {
  const t = useT();
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const connections = useConnections();
  const actions = useCollectionActions<ConnectionEntity>(
    org.id,
    "CONNECTIONS",
    useMCPClient({
      connectionId: SELF_MCP_ALIAS_ID,
      orgId: org.id,
      orgSlug: org.slug,
    }),
    { silent: true },
  );
  const queryClient = useQueryClient();
  const vtex = connections.filter(isVtex);

  const install = useMutation({
    mutationFn: async ({
      vtexId: reuse,
      keys,
    }: {
      vtexId?: string;
      keys?: Keys;
    }) => {
      const ingestUrl = await fetchOrderMonitorIngestUrl(org.slug);
      if (!ingestUrl) throw new Error(t("monitor.vtex.unavailable"));
      let vtexId = reuse;
      if (!vtexId) {
        const { item } = await callStudioTool(
          org.slug,
          "COLLECTION_REGISTRY_APP_GET",
          { name: VTEX_APP },
        );
        if (!item) throw new Error(t("monitor.vtex.unavailable"));
        const data = extractConnectionData(
          item as RegistryItem,
          org.id,
          session?.user?.id ?? "",
          { remoteIndex: 0 },
        );
        vtexId = (await actions.create.mutateAsync(data)).id;
      }
      if (keys) {
        const prev = vtex.find((c) => c.id === vtexId)?.configuration_state;
        await actions.update.mutateAsync({
          id: vtexId,
          data: { configuration_state: { ...(prev ?? {}), ...keys } },
        });
      }
      const existing = connections.find(
        (c) =>
          c.connection_url === ingestUrl &&
          (boundTo(c) === undefined || boundTo(c) === vtexId),
      );
      const ingest =
        existing ??
        (await actions.create.mutateAsync({
          title: "VTEX order monitoring",
          connection_type: "HTTP",
          connection_url: ingestUrl,
        }));
      // Saving the binding is what installs it: the ingest leases the VTEX key
      // through it and registers the store's order hook. An ingest that never
      // bound would list as a store that never gets data, so it goes.
      try {
        await actions.update.mutateAsync({
          id: ingest.id,
          data: {
            configuration_state: { VTEX: { __type: "vtex", value: vtexId } },
            // Stated, not discovered: without the grant the install gets no
            // vault token, and Studio saves the binding despite its failure.
            configuration_scopes: [INGEST_SCOPE],
          },
        });
      } catch (error) {
        if (!existing) await actions.delete.mutateAsync(ingest.id);
        const message = reason(error);
        throw /^VTEX 40[13]\b/.test(message)
          ? new RejectedKeyError(t("monitor.vtex.rejected"))
          : new Error(message);
      }
      await queryClient.invalidateQueries({
        queryKey: KEYS.orderMonitor(org.slug),
      });
    },
  });
  return { vtex, install };
}

/**
 * Connect VTEX: straight away when the org's one VTEX connection already has
 * its key; the dialog only when there is a key to ask for or a connection to
 * pick.
 */
export function VtexConnectButton({
  label,
  className,
  variant,
}: {
  label: string;
  className?: string;
  variant?: "outline";
}) {
  const { vtex, install } = useVtexInstall();
  const [open, setOpen] = useState(false);
  const [rejected, setRejected] = useState<string>();
  const direct = vtex.length === 1 && hasKeys(vtex[0]);
  return (
    <>
      <Button
        size="sm"
        variant={variant}
        className={className}
        disabled={install.isPending}
        onClick={() =>
          direct
            ? install.mutate(
                { vtexId: vtex[0]?.id },
                {
                  onError: (error) => {
                    if (!(error instanceof RejectedKeyError)) {
                      toast.error(error.message);
                      return;
                    }
                    setRejected(error.message);
                    setOpen(true);
                  },
                },
              )
            : setOpen(true)
        }
      >
        {install.isPending ? (
          <Spinner className="size-3.5" />
        ) : (
          <Plus size={14} />
        )}
        {label}
      </Button>
      {open && (
        <VtexConnectDialog
          rejected={rejected}
          onClose={() => {
            setOpen(false);
            setRejected(undefined);
          }}
        />
      )}
    </>
  );
}

function VtexConnectDialog({
  rejected,
  onClose,
}: {
  /** Why VTEX refused the key on file, which the dialog then asks for again. */
  rejected?: string;
  onClose: () => void;
}) {
  const t = useT();
  const { vtex, install: connect } = useVtexInstall();
  const [picked, setPicked] = useState<string>();
  // The first one by default, so a retry after a failed step reuses what the
  // first try created instead of creating another.
  const current = vtex.find((c) => c.id === picked) ?? vtex[0];
  const askKeys = !!rejected || !hasKeys(current);
  const [keys, setKeys] = useState<Keys>({
    accountName: String(current?.configuration_state?.accountName ?? ""),
    appKey: "",
    appToken: "",
  });

  const missing =
    askKeys && (!keys.accountName || !keys.appKey || !keys.appToken);
  const error = connect.error?.message ?? rejected;
  const field = (name: keyof Keys, label: string, secret = false) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`vtex-${name}`}>{label}</Label>
      {secret ? (
        <PasswordInput
          id={`vtex-${name}`}
          showLabel={t("common.show")}
          hideLabel={t("common.hide")}
          copyLabel={t("common.copy")}
          copiedLabel={t("common.copied")}
          value={keys[name]}
          onChange={(e) => setKeys({ ...keys, [name]: e.target.value })}
          disabled={connect.isPending}
        />
      ) : (
        <Input
          id={`vtex-${name}`}
          value={keys[name]}
          onChange={(e) => setKeys({ ...keys, [name]: e.target.value })}
          disabled={connect.isPending}
        />
      )}
    </div>
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !connect.isPending && onClose()}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("monitor.connect.orders")}</DialogTitle>
          <DialogDescription>
            {current
              ? t("monitor.vtex.existing")
              : t("monitor.vtex.description")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            connect.mutate(
              { vtexId: current?.id, keys: askKeys ? keys : undefined },
              { onSuccess: onClose },
            );
          }}
        >
          {vtex.length > 1 && (
            <Select
              value={current?.id}
              onValueChange={(id) => {
                setPicked(id);
                // Another connection's keys, not the last one's account.
                setKeys({
                  accountName: String(
                    vtex.find((c) => c.id === id)?.configuration_state
                      ?.accountName ?? "",
                  ),
                  appKey: "",
                  appToken: "",
                });
              }}
              disabled={connect.isPending}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {vtex.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {askKeys && (
            <>
              {field("accountName", t("monitor.vtex.account"))}
              {field("appKey", t("monitor.vtex.appKey"), true)}
              {field("appToken", t("monitor.vtex.appToken"), true)}
            </>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={connect.isPending}
            >
              {t("reportsOnboarding.vtexConfigForm.cancelButton")}
            </Button>
            <Button type="submit" disabled={missing || connect.isPending}>
              {connect.isPending
                ? t("monitor.vtex.connecting")
                : t("monitor.connect.short")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
