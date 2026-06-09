/**
 * Server Plugin Interface
 *
 * Defines the contract for server-side plugins that can extend Mesh with:
 * - MCP tools
 * - API routes (authenticated and public)
 * - Database migrations
 * - Storage factories
 * - Event handlers (via the event bus)
 *
 * Server plugins are separate from client plugins to avoid bundling
 * server code into the client bundle.
 */

import type { Hono } from "hono";
import type { Kysely } from "kysely";

/**
 * Subset of StudioContext exposed to server plugin tool handlers.
 *
 * Plugins receive the full StudioContext at runtime but should only depend on
 * these properties. This keeps the plugin contract stable and avoids coupling
 * plugins to Mesh internals (db, vault, tracer, etc.).
 */
export interface ServerPluginToolContext {
  organization: { id: string } | null;
  access: { check: () => Promise<void> };
  auth: {
    user?: { id: string; email?: string; name?: string };
  };
  /** Kysely database instance for direct queries. */
  db: Kysely<unknown>;
  createMCPProxy: (connectionId: string) => Promise<{
    callTool: (args: {
      name: string;
      arguments?: Record<string, unknown>;
    }) => Promise<{
      isError?: boolean;
      content?: Array<{ type?: string; text?: string }>;
      structuredContent?: unknown;
    }>;
    listTools: () => Promise<{
      tools: Array<{
        name: string;
        title?: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
        outputSchema?: Record<string, unknown>;
        annotations?: Record<string, unknown>;
      }>;
    }>;
    close?: () => Promise<void>;
  }>;
}

/**
 * Tool definition for server plugins.
 */
export interface ServerPluginToolDefinition {
  name: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  handler: (input: unknown, ctx: ServerPluginToolContext) => Promise<unknown>;
}

/**
 * Database migration definition for plugins.
 */
export interface ServerPluginMigration {
  /** Unique name for ordering (e.g., "001-initial-schema") */
  name: string;
  /** Apply the migration */
  up: (db: Kysely<unknown>) => Promise<void>;
  /** Revert the migration */
  down: (db: Kysely<unknown>) => Promise<void>;
}

/**
 * Context provided to server plugins for route registration and storage creation.
 */
export interface ServerPluginContext {
  /** Database instance */
  db: Kysely<unknown>;
  /** Credential vault for encrypting sensitive data */
  vault: {
    encrypt: (value: string) => Promise<string>;
    decrypt: (value: string) => Promise<string>;
  };
}

/**
 * Event handler context provided to plugin event handlers.
 * Contains the organization ID and a publish function for emitting follow-up events.
 */
export interface ServerPluginEventContext {
  /** Organization ID the events belong to */
  organizationId: string;
  /** Connection ID of the SELF MCP for this organization */
  connectionId: string;
  /** Publish a follow-up event to the event bus */
  publish: (
    type: string,
    subject: string,
    data?: Record<string, unknown>,
    options?: { deliverAt?: string },
  ) => Promise<void>;
  /** Create an MCP proxy client for calling tools on a connection */
  createMCPProxy: (connectionId: string) => Promise<{
    callTool: (
      params: { name: string; arguments?: Record<string, unknown> },
      resultSchema?: unknown,
      options?: { timeout?: number },
    ) => Promise<{
      content?: unknown;
      structuredContent?: unknown;
      isError?: boolean;
    }>;
    close: () => Promise<void>;
  }>;
}

/**
 * Startup context provided to plugin onStartup hooks.
 * Contains the database and a publish function for emitting recovery events.
 */
export interface ServerPluginStartupContext {
  /** Database instance */
  db: Kysely<unknown>;
  /** Publish an event to the event bus for a given organization */
  publish: (
    organizationId: string,
    event: { type: string; subject: string; data?: Record<string, unknown> },
  ) => Promise<void>;
}

/**
 * Event definition for a CloudEvent received by a plugin.
 */
export interface ServerPluginEvent {
  id: string;
  type: string;
  source: string;
  subject?: string;
  data?: unknown;
  time?: string;
}

/**
 * Server Plugin interface.
 *
 * Plugins export this interface from their server entry point.
 * Tools are registered at startup but gated by org settings at runtime.
 */
export interface ServerPlugin {
  /** Unique plugin identifier (e.g., "user-sandbox") */
  id: string;

  /** Short description shown in settings UI */
  description?: string;

  /**
   * MCP tools this plugin provides.
   * Tools are wrapped with org-enabled gating at registration time.
   */
  tools?: ServerPluginToolDefinition[];

  /**
   * Authenticated API routes.
   * Mounted at /api/plugins/:pluginId/*
   * Requires Mesh authentication.
   */
  routes?: (app: Hono, ctx: ServerPluginContext) => void;

  /**
   * Public API routes (no authentication required).
   * Mounted at the root level.
   * Use for endpoints that external users access (e.g., connect flow).
   */
  publicRoutes?: (app: Hono, ctx: ServerPluginContext) => void;

  /**
   * Database migrations for this plugin.
   * Run alongside core migrations in name order.
   */
  migrations?: ServerPluginMigration[];

  /**
   * Factory to create plugin-specific storage adapters.
   * Called during context initialization.
   */
  createStorage?: (ctx: ServerPluginContext) => unknown;

  /**
   * Event handler for this plugin.
   *
   * When defined, the system will:
   * 1. Auto-subscribe the SELF connection to the specified event types per-organization
   * 2. Route matching events from the event bus to this handler
   *
   * Events are durable (persisted in the event bus) with at-least-once delivery.
   * The handler receives batches of events and a context for publishing follow-up events.
   */
  onEvents?: {
    /** Event type patterns this plugin handles (e.g., "workflow.execution.created") */
    types: string[];
    /** Handle a batch of events. Errors are logged but don't affect other plugins. */
    handler: (
      events: ServerPluginEvent[],
      ctx: ServerPluginEventContext,
    ) => Promise<void> | void;
  };

  /**
   * Startup hook called once after the event bus is ready.
   *
   * Use this to recover from crashes (e.g., resume stuck workflow executions).
   * Called after storage is initialized and the event bus worker has started.
   * Errors are logged but don't prevent other plugins from starting.
   */
  onStartup?: (ctx: ServerPluginStartupContext) => Promise<void>;
}

/**
 * Type helper for any server plugin
 */
export type AnyServerPlugin = ServerPlugin;
