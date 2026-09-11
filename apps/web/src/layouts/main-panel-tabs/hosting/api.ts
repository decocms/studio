/**
 * The control-plane BFF's wire shapes and the few formatters the Hosting tab
 * reads them through.
 *
 * All traffic goes through `/api/:org/hosting/:site/*`, so the control-plane
 * service token never reaches the browser; the client only ever sees the
 * proxied JSON these types describe.
 */

import type { useT } from "@/i18n/use-t.ts";

export interface Deployment {
  id: string;
  env?: string | null;
  framework?: string | null;
  commitSha?: string | null;
  shortCommit?: string | null;
  phase?: string | null;
  up?: boolean | null;
  production?: boolean | null;
  servingUrl?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  durationMs?: number | null;
  createdAt?: string | null;
  source?: "managed" | "observed" | string;
  buildMessage?: string | null;
}

/** One deploy-timeline event (deploy / redeploy / rollback). */
export interface DeploymentHistoryEvent {
  id: string;
  env?: string | null;
  commitSha?: string | null;
  deploymentId?: string | null;
  framework?: string | null;
  action?: string | null;
  /** Event kind: `build` | `fast-deploy` | `deploy`. Absent on legacy rows. */
  type?: string | null;
  /** Event outcome: `pending` | `success` | `failure`. Absent on legacy rows. */
  outcome?: string | null;
  actor?: string | null;
  createdAt?: string | null;
}

/** Build-logs payload for one commit/env. `configured:false` means the platform
 *  has no build-log wiring; otherwise `text` is inline and `url` is a presigned
 *  link (expires ~5min, never cached). */
export interface BuildLogs {
  configured?: boolean;
  available?: boolean;
  reason?: string | null;
  url?: string | null;
  text?: string | null;
  truncated?: boolean;
  logs?: { name: string; url: string; sizeBytes?: number }[];
}

export type EnvScope = "runtime" | "build";

export interface EnvVar {
  name: string;
  value: string;
  /** Build phase: "runtime" (default, injected onto the running site) or "build"
   *  (passed to the build only). Absent ⇒ runtime. */
  scope?: EnvScope;
}

/** True when two vars share identity (name + effective scope). A name may exist
 *  once per scope, so edit/delete must match on both. */
export function sameEnvVar(a: EnvVar, b: { name: string; scope: EnvScope }) {
  return a.name === b.name && (a.scope ?? "runtime") === b.scope;
}

/** Secrets are listed by NAME only; values are write-only and never returned.
 *  `origin`: "control-plane" (in the CP store) or "worker" (bound on the CF
 *  Worker out-of-band, e.g. `wrangler secret put`, shown for visibility). */
export interface Secret {
  name: string;
  origin?: "control-plane" | "worker";
  /** Build phase: "runtime" (runtime bundle / CF Worker store) or "build"
   *  (mounted by the build Job only). Absent ⇒ runtime. */
  scope?: EnvScope;
  boundOnWorker?: boolean;
}

export interface Redirect {
  id?: string;
  from: string;
  to: string;
  type?: "permanent" | "temporary";
  source?: string;
}

export interface DnsRecord {
  type: string;
  name: string;
  value: string;
}

export interface Domain {
  host: string;
  canonical?: boolean;
  /** Neutral, client-facing status from the BFF (the substrate is hidden). */
  status?: "active" | "pending" | "action-required";
  /** A stable code for extra context (e.g. `zone-not-onboarded`), i18n-mapped. */
  detail?: string;
  /** The exact registrar records to create, computed by the BFF. */
  dns?: DnsRecord[];
}

export interface DomainsResult {
  dnsTemplate?: DnsRecord[];
  items?: Domain[];
}

export type Translate = ReturnType<typeof useT>;

export function list<T>(data: unknown, key: string): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object") {
    const v = (data as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v as T[];
  }
  return [];
}

/** Studio never shows the substrate, only the client-facing framework. */
export function frameworkLabel(slug: string | null | undefined): string | null {
  if (slug === "deco-deno") return "Deco Deno";
  if (slug === "deco-tanstack") return "Deco TanStack";
  return slug ?? null;
}

export function statusVariant(
  s: string | null | undefined,
): "success" | "destructive" | "warning" | "secondary" {
  const v = (s ?? "").toLowerCase();
  if (v.includes("ready") || v.includes("success") || v.includes("active")) {
    return "success";
  }
  if (v.includes("fail") || v.includes("error")) return "destructive";
  if (v.includes("build") || v.includes("pend") || v.includes("progress")) {
    return "warning";
  }
  return "secondary";
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return "—";
  const secs = Math.round((Date.now() - ms) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(secs) >= size)
      return rtf.format(-Math.round(secs / size), unit);
  }
  return rtf.format(-secs, "second");
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(secs >= 10 ? 0 : 1)}s`;
  const total = Math.round(secs);
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

/** The pre-token condition: the upstream (or its proxy) answers 401. Rendered as
 *  a calm "not connected" state, not a red error. */
export function isUnauthorized(error: unknown): boolean {
  const m = error instanceof Error ? error.message.toLowerCase() : "";
  return m.includes("unauthorized") || m.includes("401");
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorFromBody(body: unknown, status: number): string {
  return body && typeof body === "object" && "error" in body
    ? String((body as { error: unknown }).error)
    : `request failed (${status})`;
}

export async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(errorFromBody(body, res.status));
  return body;
}

export async function mutateJson(
  url: string,
  method: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(errorFromBody(data, res.status));
  return data;
}
