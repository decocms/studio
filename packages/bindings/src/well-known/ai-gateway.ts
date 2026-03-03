/**
 * AI Gateway Billing Well-Known Binding
 *
 * Defines the interface for AI gateways that support billing management.
 * Any MCP that implements this binding is recognized as a billing-capable
 * AI gateway, regardless of its URL.
 *
 * Required tools:
 * - GATEWAY_USAGE: Returns spending, usage, limits, and alert configuration
 *
 * Optional tools:
 * - GATEWAY_SET_LIMIT: Configure spending limit / add credit
 * - GATEWAY_SET_ALERT: Configure usage/balance alerts
 * - GATEWAY_CREDITS: Query credit balance
 */

import { z } from "zod";
import type { Binder } from "../core/binder";

export const GATEWAY_USAGE_INPUT = z.object({}).strict();

export const GATEWAY_USAGE_OUTPUT = z.object({
  billing: z.object({
    mode: z.enum(["prepaid", "postpaid"]),
    limitPeriod: z.enum(["daily", "weekly", "monthly"]).nullable(),
  }),
  limit: z.object({
    total: z.number().nullable(),
    remaining: z.number().nullable(),
    reset: z.string().nullable(),
  }),
  usage: z.object({
    total: z.number(),
    daily: z.number(),
    weekly: z.number(),
    monthly: z.number(),
  }),
  alert: z.object({
    enabled: z.boolean(),
    threshold_usd: z.number(),
    email: z.string().nullable(),
  }),
  connectionId: z.string(),
});

export const AI_GATEWAY_BILLING_BINDING = [
  {
    name: "GATEWAY_USAGE" as const,
    inputSchema: GATEWAY_USAGE_INPUT,
    outputSchema: GATEWAY_USAGE_OUTPUT,
  },
  {
    name: "GATEWAY_SET_LIMIT" as const,
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    opt: true,
  },
  {
    name: "GATEWAY_SET_ALERT" as const,
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    opt: true,
  },
] as const satisfies Binder;
