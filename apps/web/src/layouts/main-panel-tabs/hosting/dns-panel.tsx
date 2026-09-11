/**
 * Registrar instructions. A redirect's `from` host and an attached domain both
 * only go live once DNS points at Deco, so each row can unfold the exact
 * records to create, with a copy button per value.
 */

import type { ReactNode } from "react";
import { Globe01 } from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@decocms/ui/components/table.tsx";
import { useT } from "@/i18n/use-t.ts";
import type { DnsRecord } from "./api";
import { CopyValueButton, Th } from "./shell";

/**
 * The redirect ingress runs on eks-hub (namespace `deco-redirect-system`); its
 * NLB has three FIXED Elastic IPs. A host redirect only activates once its
 * `from` host resolves to these. Same constant the admin + control-plane DNS
 * panels use, kept in sync by hand (there is no endpoint that returns it).
 */
const REDIRECT_APEX_EIPS = [
  "16.148.147.194",
  "52.32.122.94",
  "52.35.156.199",
] as const;

/** A bare apex host (`example.com`, two labels) vs a subdomain
 *  (`old.example.com`). Apex hosts conventionally use the `@` record name. */
function isApexHost(host: string): boolean {
  return host.replace(/\.$/, "").split(".").filter(Boolean).length === 2;
}

/** A redirect whose `from` is a hostname (not a path) needs DNS to activate. */
export function isHostRedirect(from: string): boolean {
  const v = from.trim();
  return v.length > 0 && !v.startsWith("/") && v.includes(".");
}

export function DnsRecordsTable({ records }: { records: DnsRecord[] }) {
  const t = useT();
  return (
    <Table className="table-fixed">
      <TableHeader>
        <TableRow>
          <Th className="w-16">{t("mainPanelTabs.hostingTab.dnsColType")}</Th>
          <Th>{t("mainPanelTabs.hostingTab.dnsColName")}</Th>
          <Th>{t("mainPanelTabs.hostingTab.dnsColValue")}</Th>
          <Th className="w-10" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {records.map((r) => (
          <TableRow key={`${r.type}-${r.name}-${r.value}`}>
            <TableCell className="font-mono text-xs">{r.type}</TableCell>
            <TableCell className="break-all whitespace-normal font-mono text-xs">
              {r.name}
            </TableCell>
            <TableCell className="break-all whitespace-normal font-mono text-xs text-muted-foreground">
              {r.value}
            </TableCell>
            <TableCell className="text-right">
              <CopyValueButton value={r.value} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function DnsPanelFrame({
  status,
  children,
}: {
  status?: { active: boolean };
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center gap-2">
        <Globe01 className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">
          {t("mainPanelTabs.hostingTab.dnsSetupTitle")}
        </span>
        {status && (
          <Badge
            variant={status.active ? "success" : "outline"}
            className="ml-auto"
          >
            {status.active
              ? t("mainPanelTabs.hostingTab.dnsActive")
              : t("mainPanelTabs.hostingTab.dnsAwaiting")}
          </Badge>
        )}
      </div>
      {children}
    </div>
  );
}

/** `source === "both"` means the redirect is already observed live on the
 *  cluster; anything else is still pending its DNS. */
export function RedirectDnsPanel({
  from,
  source,
}: {
  from: string;
  source?: string;
}) {
  const t = useT();
  const host = from.trim().replace(/\.$/, "");
  const name = host ? (isApexHost(host) ? "@" : host) : "@";
  const active = source === "both";
  return (
    <DnsPanelFrame status={{ active }}>
      <p className="text-xs text-muted-foreground">
        {t("mainPanelTabs.hostingTab.dnsRedirectIntent", { from: host || "—" })}{" "}
        {active
          ? t("mainPanelTabs.hostingTab.dnsActiveHint")
          : t("mainPanelTabs.hostingTab.dnsAwaitingHint")}
      </p>
      <DnsRecordsTable
        records={REDIRECT_APEX_EIPS.map((ip) => ({
          type: "A",
          name,
          value: ip,
        }))}
      />
    </DnsPanelFrame>
  );
}

/** The registrar records exactly as the control-plane BFF computed them
 *  (substrate-correct, substrate-hidden). Studio only renders them. */
export function DomainDnsPanel({ records }: { records: DnsRecord[] }) {
  if (records.length === 0) return null;
  return (
    <DnsPanelFrame>
      <DnsRecordsTable records={records} />
    </DnsPanelFrame>
  );
}
