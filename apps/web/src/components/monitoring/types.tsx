/**
 * Monitoring Types and Shared Components
 *
 * Contains shared types and the ExpandedLogContent component used by LogRow.
 */

import { formatBytes } from "@/lib/format-bytes";
import { useConnections, useProjectContext } from "@/sdk";
import { getConnectionSlug } from "@decocms/shared/utils/connection-slug";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import {
  Download01,
  Check,
  Copy01,
  Play,
  Key01,
  Type01,
  FilterLines,
} from "@untitledui/icons";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { useT } from "@/i18n/use-t";
import { MONITORING_CONFIG } from "./config.ts";

// ============================================================================
// Types
// ============================================================================

import type {
  MonitoringLog as BaseMonitoringLog,
  MonitoringLogsResponse as BaseMonitoringLogsResponse,
} from "./monitoring-stats-row.tsx";
import { MonacoCodeEditor } from "../monaco-editor.tsx";

// Re-export base types for convenience
export type { BaseMonitoringLog, BaseMonitoringLogsResponse };

// ----------------------------------------------------------------------------
// Home Page Types (KPIs, Dashboard)
// ----------------------------------------------------------------------------

/** KPI metrics for the monitoring dashboard. */
export interface MonitoringStats {
  totalCalls: number;
  errorRate: number;
  avgDurationMs: number;
  errorRatePercent: string;
}

/** Extends base log with virtual MCP context (may be null if tool is not from a virtual MCP). */
export interface MonitoringLogWithVirtualMCP extends BaseMonitoringLog {
  virtualMcpId?: string | null;
}

/** Response wrapper for home page monitoring logs with pagination. */
export interface MonitoringLogsWithVirtualMCPResponse {
  logs: MonitoringLogWithVirtualMCP[];
  total: number;
}

// ----------------------------------------------------------------------------
// Full Monitoring Page Types
// ============================================================================
// TRUST BOUNDARY: MonitoringLog contains user-submitted input/output from tool calls.
// Callers MUST validate input/output before display or further processing.
// ============================================================================

/** Complete monitoring log for a single tool call (API response).
 * @trust-boundary input and output are untrusted user/tool-generated data
 */
export interface MonitoringLog extends BaseMonitoringLog {
  organizationId: string;
  userId: string | null;
  requestId: string;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  userAgent: string | null;
  virtualMcpId: string | null;
  properties: Record<string, string> | null;
}

/** MonitoringLog enriched with resolved user and virtual MCP metadata.
 * Safe for display; trust boundary validation already applied.
 */
export interface EnrichedMonitoringLog extends MonitoringLog {
  userName: string;
  userImage: string | undefined;
  virtualMcpName: string | null;
  virtualMcpIcon: string | null;
}

/** Paginated response wrapper for full monitoring logs. */
export interface MonitoringLogsResponse
  extends Omit<BaseMonitoringLogsResponse, "logs"> {
  logs: MonitoringLog[];
}

/** Search and filter parameters for the monitoring dashboard.
 * Designed as URL-safe serializable state; values are validated on deserialization.
 */
export interface MonitoringSearchParams {
  tab?: "overview" | "audit" | "dashboards" | "threads" | "automations";
  from?: string;
  to?: string;
  connectionId?: string[];
  virtualMcpId?: string[];
  tool?: string;
  status?: "all" | "success" | "errors";
  search?: string;
  page?: number;
  streaming?: boolean;
  propertyFilters?: string;
  hideSystem?: boolean;
}

// ============================================================================
// Property Filter Types
// ============================================================================
// TRUST BOUNDARY: property filters come from URL params and must be validated.
// ============================================================================

export type PropertyFilterOperator = "eq" | "contains" | "exists" | "in";

const PROPERTY_FILTER_OPERATORS: readonly PropertyFilterOperator[] = [
  "eq",
  "contains",
  "exists",
  "in",
];

/** Type guard: validates that a value is a known PropertyFilterOperator.
 * Unknown operators fall back to "eq" in deserialization.
 */
function isPropertyFilterOperator(
  value: string,
): value is PropertyFilterOperator {
  return (PROPERTY_FILTER_OPERATORS as readonly string[]).includes(value);
}

/** Parsed property filter for a single criterion.
 * @param key - property key (non-empty after trim)
 * @param operator - comparison operator
 * @param value - comparison value (empty for "exists" operator)
 */
export interface PropertyFilter {
  key: string;
  operator: PropertyFilterOperator;
  value: string;
}

/**
 * Serialize property filters to URL-safe string.
 * Format: "key:operator:value,key2:operator2:value2"
 */
export function serializePropertyFilters(filters: PropertyFilter[]): string {
  return filters
    .filter((f) => f.key.trim()) // Skip empty keys
    .map((f) => {
      const key = encodeURIComponent(f.key.trim());
      const value = encodeURIComponent(f.value || "");
      return `${key}:${f.operator}:${value}`;
    })
    .join(",");
}

/** Deserialize property filters from URL-encoded string.
 * Format: "key:operator:value,key2:operator2:value2"
 * Safely handles malformed input by falling back to "eq" operator for unknown types.
 */
export function deserializePropertyFilters(str: string): PropertyFilter[] {
  if (!str || typeof str !== "string") return [];
  return str
    .split(",")
    .map((part) => {
      if (!part) return undefined;
      const [key, operator, ...valueParts] = part.split(":");
      const decodedKey = key ? decodeURIComponent(key) : "";
      if (!decodedKey.trim()) return undefined;
      return {
        key: decodedKey,
        operator:
          operator && isPropertyFilterOperator(operator) ? operator : "eq",
        value: decodeURIComponent(valueParts.join(":") || ""),
      };
    })
    .filter((f) => f !== undefined);
}

/**
 * Convert property filters to raw text format.
 * Format: one filter per line as "key=value" or "key~value" or "key?" or "key@value"
 */
export function propertyFiltersToRaw(filters: PropertyFilter[]): string {
  return filters
    .filter((f) => f.key.trim())
    .map((f) => {
      switch (f.operator) {
        case "eq":
          return `${f.key}=${f.value}`;
        case "contains":
          return `${f.key}~${f.value}`;
        case "exists":
          return `${f.key}?`;
        case "in":
          return `${f.key}@${f.value}`;
      }
    })
    .join("\n");
}

/**
 * Parse raw text format into property filters.
 * Supports:
 * - "key=value" → equals
 * - "key~value" → contains
 * - "key?" → exists
 * - "key@value" → in (exact match within comma-separated values)
 */
export function parseRawPropertyFilters(raw: string): PropertyFilter[] {
  if (!raw.trim()) return [];

  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      // Check for exists (key?)
      if (line.endsWith("?")) {
        return {
          key: line.slice(0, -1),
          operator: "exists" as PropertyFilterOperator,
          value: "",
        };
      }
      // Check for equals first (key=value) - must come before contains and "in"
      // to handle values containing ~ or @ (e.g., email=user@example.com)
      if (line.includes("=")) {
        const [key, ...valueParts] = line.split("=");
        return {
          key: key || "",
          operator: "eq" as PropertyFilterOperator,
          value: valueParts.join("="),
        };
      }
      // Check for contains (key~value) - must come before "in"
      // to handle values containing @ (e.g., field~test@value)
      if (line.includes("~")) {
        const [key, ...valueParts] = line.split("~");
        return {
          key: key || "",
          operator: "contains" as PropertyFilterOperator,
          value: valueParts.join("~"),
        };
      }
      // Check for "in" operator (key@value) - exact match within comma-separated list
      // Only matches when @ is the first operator (no = or ~ before it)
      if (line.includes("@")) {
        const [key, ...valueParts] = line.split("@");
        return {
          key: key || "",
          operator: "in" as PropertyFilterOperator,
          value: valueParts.join("@"),
        };
      }
      // Just a key without operator - treat as exists
      return {
        key: line,
        operator: "exists" as PropertyFilterOperator,
        value: "",
      };
    });
}

/**
 * Convert property filters to API params.
 */
export function propertyFiltersToApiParams(filters: PropertyFilter[]): {
  properties?: Record<string, string>;
  propertyPatterns?: Record<string, string>;
  propertyKeys?: string[];
  propertyInValues?: Record<string, string>;
} {
  const properties: Record<string, string> = {};
  const propertyPatterns: Record<string, string> = {};
  const propertyKeys: string[] = [];
  const propertyInValues: Record<string, string> = {};

  for (const filter of filters) {
    if (!filter.key.trim()) continue;

    switch (filter.operator) {
      case "eq":
        if (filter.value) {
          properties[filter.key] = filter.value;
        }
        break;
      case "contains":
        if (filter.value) {
          propertyPatterns[filter.key] = `%${filter.value}%`;
        }
        break;
      case "exists":
        propertyKeys.push(filter.key);
        break;
      case "in":
        if (filter.value) {
          propertyInValues[filter.key] = filter.value;
        }
        break;
    }
  }

  return {
    properties: Object.keys(properties).length > 0 ? properties : undefined,
    propertyPatterns:
      Object.keys(propertyPatterns).length > 0 ? propertyPatterns : undefined,
    propertyKeys: propertyKeys.length > 0 ? propertyKeys : undefined,
    propertyInValues:
      Object.keys(propertyInValues).length > 0 ? propertyInValues : undefined,
  };
}

// ============================================================================
// JSON Processing Utilities
// ============================================================================

interface TruncatedJson {
  content: string;
  isTruncated: boolean;
  originalSize: number;
}

/**
 * Safely process and optionally truncate JSON data for display.
 * Handles both regular objects and server-side pre-truncated payloads.
 *
 * @param data Raw JSON object (null-safe). May contain `_decocms_truncated` string for server-truncated payloads.
 * @returns Processed JSON with truncation flag and original size.
 * @throws Never — always returns a valid TruncatedJson even on malformed input.
 */
function truncateJsonForDisplay(
  data: Record<string, unknown> | null,
): TruncatedJson {
  if (!data) {
    return { content: "null", isTruncated: false, originalSize: 4 };
  }

  // Server-side truncated output: render the raw truncated string directly.
  // Guard: ensure the property exists, is a string, and is non-empty.
  const truncatedProp = data._decocms_truncated;
  if (typeof truncatedProp === "string" && truncatedProp.length > 0) {
    return {
      content: truncatedProp,
      isTruncated: true,
      originalSize: truncatedProp.length,
    };
  }

  // Regular object: stringify and check size.
  let fullJson: string;
  try {
    fullJson = JSON.stringify(data, null, 2);
  } catch {
    // Fallback for circular refs or non-serializable values.
    return {
      content: "[Unable to serialize JSON]",
      isTruncated: false,
      originalSize: 0,
    };
  }

  const originalSize = fullJson.length;

  if (originalSize <= MONITORING_CONFIG.maxJsonRenderSize) {
    return { content: fullJson, isTruncated: false, originalSize };
  }

  // Truncate and add indicator.
  const truncated = fullJson.slice(0, MONITORING_CONFIG.maxJsonRenderSize);
  return {
    content: truncated + "\n\n... [TRUNCATED - content too large to display]",
    isTruncated: true,
    originalSize,
  };
}

// ============================================================================
// Expanded Log Content Component
// ============================================================================

interface ExpandedLogContentProps {
  log: EnrichedMonitoringLog;
}

export function ExpandedLogContent({ log }: ExpandedLogContentProps) {
  const [copiedInput, setCopiedInput] = useState(false);
  const [copiedOutput, setCopiedOutput] = useState(false);
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const t = useT();
  // Reads from the same cache the monitoring page already populated, so this
  // doesn't trigger an extra fetch — we just need the connection's slug
  // (the tool detail route keys off $appSlug, not the connection id).
  const connections = useConnections();

  // Process JSON for display (React 19 compiler handles optimization)
  const inputJson = truncateJsonForDisplay(log.input);
  const outputJson = truncateJsonForDisplay(log.output);

  // Keep full JSON for copy (stringify lazily only when copying)
  const getFullJson = (data: Record<string, unknown> | null) =>
    JSON.stringify(data, null, 2);

  const handleCopy = async (type: "input" | "output") => {
    // Always copy full JSON, not truncated
    const fullJson = getFullJson(type === "input" ? log.input : log.output);
    try {
      await navigator.clipboard.writeText(fullJson);
      if (type === "input") {
        setCopiedInput(true);
        setTimeout(() => setCopiedInput(false), 2000);
      } else {
        setCopiedOutput(true);
        setTimeout(() => setCopiedOutput(false), 2000);
      }
    } catch (error) {
      toast.error(t("monitoring.types.failedToCopy"));
    }
  };

  const handleDownload = (type: "input" | "output") => {
    const fullJson = getFullJson(type === "input" ? log.input : log.output);
    const blob = new Blob([fullJson], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${log.toolName}-${type}-${log.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleReplay = () => {
    // The tool detail route resolves connections by slug ($appSlug), not by id,
    // so map this log's connectionId to its slug before navigating.
    const connection = connections.find((c) => c.id === log.connectionId);
    if (!connection) {
      toast.error(t("monitoring.types.connectionNotFound"));
      return;
    }
    // Generate unique replay ID
    const replayId = crypto.randomUUID();
    // Store input in sessionStorage
    sessionStorage.setItem(`replay-${replayId}`, JSON.stringify(log.input));
    // Navigate to tool page with replayId
    navigate({
      to: "/$org/settings/connections/$appSlug/$collectionName/$itemId",
      params: {
        org: org.slug,
        appSlug: getConnectionSlug(connection),
        collectionName: "tools",
        itemId: encodeURIComponent(log.toolName),
      },
      search: { replayId },
    });
  };

  const [copiedRequestId, setCopiedRequestId] = useState(false);

  const handleCopyRequestId = async () => {
    try {
      await navigator.clipboard.writeText(log.requestId);
      setCopiedRequestId(true);
      setTimeout(() => setCopiedRequestId(false), 2000);
    } catch (error) {
      toast.error(t("monitoring.types.failedToCopy"));
    }
  };

  const timestamp = new Date(log.timestamp);
  const formattedTimestamp = timestamp.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  return (
    <div className="text-sm px-5 md:px-6 py-5 space-y-5">
      {/* Unified info grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
        {/* Timestamp */}
        <div>
          <div className="text-xs text-muted-foreground mb-1">
            {t("monitoring.types.timestamp")}
          </div>
          <div className="text-sm text-foreground">{formattedTimestamp}</div>
        </div>

        {/* Duration */}
        <div>
          <div className="text-xs text-muted-foreground mb-1">
            {t("monitoring.types.duration")}
          </div>
          <div className="text-sm font-mono text-foreground">
            {log.durationMs}ms
          </div>
        </div>

        {/* User */}
        <div>
          <div className="text-xs text-muted-foreground mb-1">
            {t("monitoring.types.user")}
          </div>
          <div className="text-sm text-foreground">{log.userName}</div>
        </div>

        {/* Agent */}
        {log.virtualMcpName && (
          <div>
            <div className="text-xs text-muted-foreground mb-1">
              {t("monitoring.types.agent")}
            </div>
            <div className="text-sm text-foreground">{log.virtualMcpName}</div>
          </div>
        )}

        {/* Request ID */}
        <div>
          <div className="text-xs text-muted-foreground mb-1">
            {t("monitoring.types.requestId")}
          </div>
          <div className="flex items-center gap-1">
            <code className="font-mono text-foreground text-[11px]">
              {log.requestId}
            </code>
            <Button
              size="icon"
              variant="ghost"
              onClick={handleCopyRequestId}
              aria-label={t("monitoring.types.copyRequestId")}
              className="h-5 w-5 text-muted-foreground hover:text-foreground"
            >
              {copiedRequestId ? <Check size={12} /> : <Copy01 size={12} />}
            </Button>
          </div>
        </div>

        {/* Client */}
        {log.userAgent && (
          <div>
            <div className="text-xs text-muted-foreground mb-1">
              {t("monitoring.types.client")}
            </div>
            <div className="text-sm font-mono text-foreground">
              {log.userAgent}
            </div>
          </div>
        )}

        {/* Properties */}
        {log.properties && Object.keys(log.properties).length > 0 && (
          <div className="md:col-span-2">
            <div className="text-xs text-muted-foreground mb-1.5">
              {t("monitoring.types.properties")}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(log.properties).map(([key, value]) => (
                <Popover key={key}>
                  <PopoverTrigger asChild>
                    <Badge
                      variant="secondary"
                      className="font-mono text-xs px-2 py-0.5 cursor-pointer hover:bg-secondary/80 transition-colors"
                    >
                      {key}={value}
                    </Badge>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-1" align="end">
                    <div className="flex flex-col gap-0.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="justify-start h-8 px-2 text-xs font-normal focus-visible:ring-0 focus-visible:ring-offset-0"
                        onClick={() => {
                          const filter: PropertyFilter = {
                            key,
                            operator: "eq",
                            value,
                          };
                          navigate({
                            to: "/$org/settings/monitor",
                            params: {
                              org: org.slug,
                            },
                            search: {
                              propertyFilters: serializePropertyFilters([
                                filter,
                              ]),
                            },
                          });
                        }}
                      >
                        <FilterLines size={14} className="mr-2" />
                        {t("monitoring.types.filterByProperty")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="justify-start h-8 px-2 text-xs font-normal focus-visible:ring-0 focus-visible:ring-offset-0"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(
                              `${key}=${value}`,
                            );
                            toast.success(t("monitoring.types.copiedFilter"));
                          } catch (error) {
                            toast.error(t("monitoring.types.failedToCopy"));
                          }
                        }}
                      >
                        <Copy01 size={14} className="mr-2" />
                        {t("monitoring.types.copyFilter")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="justify-start h-8 px-2 text-xs font-normal focus-visible:ring-0 focus-visible:ring-offset-0"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(key);
                            toast.success(t("monitoring.types.copiedKey"));
                          } catch (error) {
                            toast.error(t("monitoring.types.failedToCopy"));
                          }
                        }}
                      >
                        <Key01 size={14} className="mr-2" />
                        {t("monitoring.types.copyKey")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="justify-start h-8 px-2 text-xs font-normal focus-visible:ring-0 focus-visible:ring-offset-0"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(value);
                            toast.success(t("monitoring.types.copiedValue"));
                          } catch (error) {
                            toast.error(t("monitoring.types.failedToCopy"));
                          }
                        }}
                      >
                        <Type01 size={14} className="mr-2" />
                        {t("monitoring.types.copyValue")}
                      </Button>
                    </div>
                  </PopoverContent>
                </Popover>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Error message */}
      {log.errorMessage && (
        <div>
          <div className="text-xs text-destructive mb-1">
            {t("monitoring.types.error")}
          </div>
          <div className="text-destructive font-mono text-xs bg-destructive/10 p-2 rounded break-all">
            {log.errorMessage}
          </div>
        </div>
      )}

      {/* JSON viewers — stacked */}
      <div className="space-y-4">
        <div>
          <div className="rounded-lg overflow-hidden border border-border">
            <div className="flex items-center justify-between p-1 pl-4 border-b border-border">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground select-none">
                  {t("monitoring.types.input")}
                </span>
                {inputJson.isTruncated && (
                  <span className="text-xs text-warning">
                    ({formatBytes(inputJson.originalSize)} -{" "}
                    {t("monitoring.types.truncated")})
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {log.input && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={handleReplay}
                        aria-label={t("monitoring.types.replayToolCall")}
                        className="text-muted-foreground hover:text-foreground rounded-lg h-8 w-8"
                      >
                        <Play size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {t("monitoring.types.replayToolCall")}
                    </TooltipContent>
                  </Tooltip>
                )}
                {inputJson.isTruncated && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => handleDownload("input")}
                        aria-label={t("monitoring.types.downloadFullInput")}
                        className="text-muted-foreground hover:text-foreground rounded-lg h-8 w-8"
                      >
                        <Download01 size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {t("monitoring.types.downloadFullInput")}
                    </TooltipContent>
                  </Tooltip>
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => handleCopy("input")}
                  aria-label={t("monitoring.types.copyInput")}
                  className="text-muted-foreground hover:text-foreground rounded-lg h-8 w-8"
                >
                  {copiedInput ? <Check size={14} /> : <Copy01 size={14} />}
                </Button>
              </div>
            </div>
            <div className="h-[200px] md:h-[280px] overflow-auto">
              <MonacoCodeEditor
                code={inputJson.content}
                language="json"
                height="100%"
                readOnly
              />
            </div>
          </div>
        </div>
        <div>
          <div className="rounded-lg overflow-hidden border border-border">
            <div className="flex items-center justify-between p-1 pl-4 border-b border-border">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground select-none">
                  {t("monitoring.types.output")}
                </span>
                {outputJson.isTruncated && (
                  <span className="text-xs text-warning">
                    ({formatBytes(outputJson.originalSize)} -{" "}
                    {t("monitoring.types.truncated")})
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {outputJson.isTruncated && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => handleDownload("output")}
                        aria-label={t("monitoring.types.downloadFullOutput")}
                        className="text-muted-foreground hover:text-foreground rounded-lg h-8 w-8"
                      >
                        <Download01 size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {t("monitoring.types.downloadFullOutput")}
                    </TooltipContent>
                  </Tooltip>
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => handleCopy("output")}
                  aria-label={t("monitoring.types.copyOutput")}
                  className="text-muted-foreground hover:text-foreground rounded-lg h-8 w-8"
                >
                  {copiedOutput ? <Check size={14} /> : <Copy01 size={14} />}
                </Button>
              </div>
            </div>
            <div className="h-[200px] md:h-[280px] overflow-auto">
              <MonacoCodeEditor
                code={outputJson.content}
                language="json"
                height="100%"
                readOnly
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
