/* oxlint-disable no-explicit-any */
/* oxlint-disable ban-types */
import { OnEventsInputSchema, OnEventsOutputSchema } from "@decocms/bindings";
import { sharedJsonSchemaValidator } from "@decocms/mcp-utils";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport as HttpServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type {
  CallToolResult,
  GetPromptResult,
  Implementation,
  ListToolsResult,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ZodSchema, ZodTypeAny } from "zod";
import { BindingRegistry, injectBindingSchemas } from "./bindings.ts";
import { Event, type EventHandlers } from "./events.ts";
import type { DefaultEnv, User } from "./index.ts";
import { State } from "./state.ts";
import {
  type InstallContext,
  type StudioVaultBootstrap,
  makeCreateAgent,
} from "./agents.ts";

// Re-export EventHandlers type and SELF constant for external use
export { SELF } from "./events.ts";
export type { EventHandlers } from "./events.ts";
export { AGENT_SCOPES } from "./agents.ts";
export type {
  InstallContext,
  StudioVaultBootstrap,
  CreateAgentInput,
  CreateAgentResult,
  CreatedAutomation,
  TriggerResult,
  AutomationTrigger,
} from "./agents.ts";

export const createRuntimeContext = (prev?: AppContext) => {
  const store = State.getStore();
  if (!store) {
    if (prev) {
      return prev;
    }
    throw new Error("Missing context, did you forget to call State.bind?");
  }
  return store;
};

export interface ToolExecutionContext<
  TSchemaIn extends ZodTypeAny = ZodTypeAny,
> {
  context: z.infer<TSchemaIn>;
  runtimeContext: AppContext;
}

/**
 * Tool interface with generic schema types for type-safe tool creation.
 *
 * TId preserves the literal string type of `id` so consumers (e.g. the
 * workflow builder) can derive union types of tool names without codegen.
 */
export interface Tool<
  TSchemaIn extends ZodTypeAny = ZodTypeAny,
  TSchemaOut extends ZodTypeAny | undefined = undefined,
  TId extends string = string,
> {
  _meta?: Record<string, unknown>;
  id: TId;
  /** Human-readable name exposed via MCP tools/list `title` */
  title?: string;
  description?: string;
  annotations?: ToolAnnotations;
  inputSchema: TSchemaIn;
  outputSchema?: TSchemaOut;
  execute(
    context: ToolExecutionContext<TSchemaIn>,
    ctx?: AppContext,
  ): TSchemaOut extends ZodSchema
    ? Promise<z.infer<TSchemaOut>>
    : Promise<unknown>;
}

/**
 * CreatedTool is a permissive type that any Tool can be assigned to.
 * Uses a structural type with relaxed execute signature to allow tools with any schema.
 */
export type CreatedTool = {
  _meta?: Record<string, unknown>;
  id: string;
  title?: string;
  description?: string;
  annotations?: ToolAnnotations;
  inputSchema: ZodTypeAny;
  outputSchema?: ZodTypeAny;
  // Use a permissive execute signature - accepts any context shape
  execute(
    context: {
      context: unknown;
      runtimeContext: AppContext;
    },
    ctx?: AppContext,
  ): Promise<unknown>;
};

// Re-export types for external use
export type {
  GetPromptResult,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * Prompt argument schema shape - must be string types per MCP specification.
 * Unlike tool arguments, prompt arguments are always strings.
 */
export type PromptArgsRawShape = {
  [k: string]: z.ZodType<string> | z.ZodOptional<z.ZodType<string>>;
};

/**
 * Context passed to prompt execute functions.
 */
export interface PromptExecutionContext<
  _TArgs extends PromptArgsRawShape = PromptArgsRawShape,
> {
  args: Record<string, string | undefined>;
  runtimeContext: AppContext;
}

/**
 * Prompt interface with generic argument types for type-safe prompt creation.
 */
export interface Prompt<TArgs extends PromptArgsRawShape = PromptArgsRawShape> {
  name: string;
  title?: string;
  description?: string;
  argsSchema?: TArgs;
  execute(
    context: PromptExecutionContext<TArgs>,
    ctx?: AppContext,
  ): Promise<GetPromptResult> | GetPromptResult;
}

/**
 * CreatedPrompt is a permissive type that any Prompt can be assigned to.
 * Uses a structural type with relaxed execute signature to allow prompts with any schema.
 */
export type CreatedPrompt = {
  name: string;
  title?: string;
  description?: string;
  argsSchema?: PromptArgsRawShape;
  // Use a permissive execute signature - accepts any args shape
  execute(
    context: {
      args: Record<string, string | undefined>;
      runtimeContext: AppContext;
    },
    ctx?: AppContext,
  ): Promise<GetPromptResult> | GetPromptResult;
};

// ============================================================================
// Resource Types
// ============================================================================

/**
 * Context passed to resource read functions.
 */
export interface ResourceExecutionContext {
  uri: URL;
  runtimeContext: AppContext;
}

/**
 * Resource contents returned from read operations.
 * Per MCP spec, resources return either text or blob content.
 */
export interface ResourceContents {
  /** The URI of the resource */
  uri: string;
  /** MIME type of the content */
  mimeType?: string;
  /** Text content (for text-based resources) */
  text?: string;
  /** Base64-encoded binary content (for binary resources) */
  blob?: string;
}

/**
 * Resource interface for defining MCP resources.
 * Resources are read-only, addressable entities that expose data like config, docs, or context.
 */
export interface Resource {
  /** Resource URI (static) or URI template (e.g., "config://app" or "file://{path}") */
  uri: string;
  /** Human-readable name for the resource */
  name: string;
  /** Description of what the resource contains */
  description?: string;
  /** MIME type of the resource content */
  mimeType?: string;
  /** Handler function to read the resource content */
  read(
    context: ResourceExecutionContext,
    ctx?: AppContext,
  ): Promise<ResourceContents> | ResourceContents;
}

/**
 * CreatedResource is a permissive type that any Resource can be assigned to.
 * Uses a structural type with relaxed read signature to allow resources with any context.
 */
export type CreatedResource = {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  read(
    context: {
      uri: URL;
      runtimeContext: AppContext;
    },
    ctx?: AppContext,
  ): Promise<ResourceContents> | ResourceContents;
};

/**
 * Ensure the current request is authenticated.
 * Reads from the per-request AppContext (AsyncLocalStorage), not from a cached env.
 *
 * @param ctx - Per-request AppContext from the second arg of execute/read handlers
 * @returns The authenticated User
 * @throws Error if no request context or user is not authenticated
 */
export function ensureAuthenticated(ctx: AppContext): User {
  const reqCtx =
    ctx?.env?.STUDIO_REQUEST_CONTEXT ?? ctx?.env?.MESH_REQUEST_CONTEXT;
  if (!reqCtx) {
    throw new Error("Unauthorized: missing request context");
  }
  const user = reqCtx.ensureAuthenticated();
  if (!user) {
    throw new Error("Unauthorized");
  }
  return user;
}

let _warnedPrivateTool = false;

/**
 * @deprecated Use `createTool` with `ensureAuthenticated(ctx)` instead.
 *
 * Creates a private tool that ensures authentication before execution.
 */
export function createPrivateTool<
  TSchemaIn extends ZodSchema = ZodSchema,
  TSchemaOut extends ZodSchema | undefined = undefined,
>(opts: Tool<TSchemaIn, TSchemaOut>): Tool<TSchemaIn, TSchemaOut> {
  if (!_warnedPrivateTool) {
    console.warn(
      "[runtime] createPrivateTool is deprecated. Use createTool with ensureAuthenticated(ctx) instead.",
    );
    _warnedPrivateTool = true;
  }
  const execute = opts.execute;
  opts.execute = (input: ToolExecutionContext<TSchemaIn>, ctx: AppContext) => {
    ensureAuthenticated(ctx);
    return execute(input, ctx);
  };
  return createTool(opts);
}

export function createTool<
  TSchemaIn extends ZodSchema = ZodSchema,
  TSchemaOut extends ZodSchema | undefined = undefined,
  TId extends string = string,
>(opts: Tool<TSchemaIn, TSchemaOut, TId>): Tool<TSchemaIn, TSchemaOut, TId> {
  return {
    ...opts,
    execute: (input: ToolExecutionContext<TSchemaIn>) => {
      const ctx = createRuntimeContext(input.runtimeContext);
      return opts.execute({ ...input, runtimeContext: ctx }, ctx);
    },
  };
}

/**
 * Creates a public prompt that does not require authentication.
 */
export function createPublicPrompt<TArgs extends PromptArgsRawShape>(
  opts: Prompt<TArgs>,
): Prompt<TArgs> {
  return {
    ...opts,
    execute: (input: PromptExecutionContext<TArgs>) => {
      const ctx = createRuntimeContext(input.runtimeContext);
      return opts.execute({ ...input, runtimeContext: ctx }, ctx);
    },
  };
}

/**
 * Creates a prompt that always ensures authentication before being executed.
 * This is the default and recommended way to create prompts.
 */
export function createPrompt<TArgs extends PromptArgsRawShape>(
  opts: Prompt<TArgs>,
): Prompt<TArgs> {
  const execute = opts.execute;
  return createPublicPrompt({
    ...opts,
    execute: (input: PromptExecutionContext<TArgs>, ctx: AppContext) => {
      ensureAuthenticated(ctx);
      return execute(input, ctx);
    },
  });
}

/**
 * Creates a public resource that does not require authentication.
 */
export function createPublicResource(opts: Resource): Resource {
  return {
    ...opts,
    read: (input: ResourceExecutionContext) => {
      const ctx = createRuntimeContext(input.runtimeContext);
      return opts.read({ ...input, runtimeContext: ctx }, ctx);
    },
  };
}

/**
 * Creates a resource that always ensures authentication before being read.
 * This is the default and recommended way to create resources.
 */
export function createResource(opts: Resource): Resource {
  const read = opts.read;
  return createPublicResource({
    ...opts,
    read: (input: ResourceExecutionContext, ctx: AppContext) => {
      ensureAuthenticated(ctx);
      return read(input, ctx);
    },
  });
}

export interface ViewExport {
  title: string;
  icon: string;
  url: string;
  tools?: string[];
  rules?: string[];
  installBehavior?: "none" | "open" | "autoPin";
}

export interface Integration {
  id: string;
  appId: string;
}

export interface OnChangeCallback<TState> {
  state: TState;
  scopes: ConfigurationScope[];
  vault?: StudioVaultBootstrap;
}

/**
 * Canonical scope value for reading a refreshable OAuth access token from
 * Studio's credential vault for a configured binding.
 *
 * Use it in configuration scopes as `${STATE_KEY}::credential:access-token:read`,
 * where `STATE_KEY` points at a `BindingOf(...)` value in configuration state.
 * This scope is intentionally narrower than static secret access: Studio should
 * return only the current access token and keep refresh tokens/client secrets
 * inside the vault.
 *
 * @example
 * ```ts
 * const scopes = ["github::credential:access-token:read"] satisfies ConfigurationScope[];
 * ```
 */
export const CREDENTIAL_ACCESS_TOKEN_READ_SCOPE =
  "credential:access-token:read" as const;

/**
 * Canonical scope value for reading saved MCP configuration state from
 * Studio's credential vault for a configured binding.
 *
 * Use it in configuration scopes as
 * `${STATE_KEY}::credential:configuration:read`, where `STATE_KEY` points at a
 * `BindingOf(...)` value in configuration state. This scope is intentionally
 * separate from OAuth access-token reads because some MCPs store provider
 * settings or credentials in configuration state instead of OAuth.
 *
 * The runtime vault client returns Studio's already-saved configuration state;
 * it does not call the target MCP's `MCP_CONFIGURATION` discovery tool.
 *
 * @example
 * ```ts
 * const scopes = ["github::credential:configuration:read"] satisfies ConfigurationScope[];
 * ```
 */
export const CREDENTIAL_CONFIGURATION_READ_SCOPE =
  "credential:configuration:read" as const;

export type CredentialAccessTokenReadScope =
  typeof CREDENTIAL_ACCESS_TOKEN_READ_SCOPE;
export type CredentialConfigurationReadScope =
  typeof CREDENTIAL_CONFIGURATION_READ_SCOPE;

export type BindingCredentialAccessTokenReadScope<
  TStateKey extends string = string,
> = `${TStateKey}::${CredentialAccessTokenReadScope}`;
export type BindingCredentialConfigurationReadScope<
  TStateKey extends string = string,
> = `${TStateKey}::${CredentialConfigurationReadScope}`;

/**
 * Configuration scopes use `STATE_KEY::SCOPE`, where `STATE_KEY` points at a
 * value in the MCP configuration state. Most scopes are MCP-specific tool or
 * capability names. `credential:access-token:read` leases a downstream OAuth
 * access token for direct API calls, and `credential:configuration:read` reads
 * the target connection's saved MCP configuration state.
 */
export type ConfigurationScope =
  | BindingCredentialAccessTokenReadScope
  | BindingCredentialConfigurationReadScope
  | string;

/**
 * OAuth 2.0 Token Exchange Parameters
 * Parameters passed to exchangeCode() for token retrieval
 * @see https://datatracker.ietf.org/doc/html/rfc6749#section-4.1.3
 */
export interface OAuthParams {
  /** REQUIRED - The authorization code received from the authorization server */
  code: string;
  /** OPTIONAL - PKCE code verifier (RFC 7636) */
  code_verifier?: string;
  /** OPTIONAL - Code challenge method: S256 (SHA-256) or plain */
  code_challenge_method?: "S256" | "plain";
  /**
   * OPTIONAL - The redirect_uri used in the authorization request
   * MUST be identical if included in the authorization request
   */
  redirect_uri?: string;
}

/**
 * OAuth 2.0 Token Response
 * Response from the authorization server's token endpoint
 * @see https://datatracker.ietf.org/doc/html/rfc6749#section-5.1
 */
export interface OAuthTokenResponse {
  /** REQUIRED - The access token issued by the authorization server */
  access_token: string;
  /** REQUIRED - Type of token (usually "Bearer" per RFC 6750) */
  token_type: string;
  /** RECOMMENDED - Lifetime in seconds of the access token */
  expires_in?: number;
  /** OPTIONAL - Used to obtain new access tokens (if applicable) */
  refresh_token?: string;
  /** OPTIONAL - Scope of the access token (if different from requested) */
  scope?: string;
  /** Additional provider-specific fields */
  [key: string]: unknown;
}

/**
 * OAuth 2.0 Client Metadata (Dynamic Client Registration)
 * @see https://datatracker.ietf.org/doc/html/rfc7591#section-2
 * @see https://datatracker.ietf.org/doc/html/rfc7591#section-3.2.1
 */
export interface OAuthClient {
  /** REQUIRED - OAuth 2.0 client identifier string */
  client_id: string;
  /** OPTIONAL - OAuth 2.0 client secret string (confidential clients) */
  client_secret?: string;
  /** OPTIONAL - Human-readable name of the client */
  client_name?: string;
  /** REQUIRED - Array of redirect URIs for use in redirect-based flows */
  redirect_uris: string[];
  /** OPTIONAL - Array of OAuth 2.0 grant types (e.g., "authorization_code", "refresh_token") */
  grant_types?: string[];
  /** OPTIONAL - Array of response types (e.g., "code", "token") */
  response_types?: string[];
  /** OPTIONAL - Authentication method for the token endpoint (e.g., "client_secret_basic", "none") */
  token_endpoint_auth_method?: string;
  /** OPTIONAL - Space-separated list of scope values */
  scope?: string;
  /** OPTIONAL - Time at which the client identifier was issued (Unix timestamp) */
  client_id_issued_at?: number;
  /** OPTIONAL - Time at which the client secret expires (Unix timestamp, 0 = never) */
  client_secret_expires_at?: number;
}

/**
 * OAuth configuration for MCP servers implementing PKCE flow
 * Per MCP Authorization spec: https://modelcontextprotocol.io/specification/draft/basic/authorization
 */
export interface OAuthConfig {
  mode: "PKCE";
  /**
   * The external authorization server URL (e.g., "https://openrouter.ai")
   * Used in protected resource metadata to indicate where clients should authenticate
   */
  authorizationServer: string;
  /**
   * Generates the authorization URL where users should be redirected
   * @param callbackUrl - The URL the OAuth provider will redirect back to with the code
   * @returns The full authorization URL to redirect the user to
   */
  authorizationUrl: (callbackUrl: string) => string;
  /**
   * Exchanges the authorization code for access tokens
   * Called when the OAuth callback is received with a code
   */
  exchangeCode: (oauthParams: OAuthParams) => Promise<OAuthTokenResponse>;
  /**
   * Refreshes the access token using a refresh token
   * Called when the client requests a new access token with grant_type=refresh_token
   */
  refreshToken?: (refreshToken: string) => Promise<OAuthTokenResponse>;
  /**
   * Optional: persistence for dynamic client registration (RFC7591)
   * If not provided, clients are accepted without validation
   */
  persistence?: {
    getClient: (clientId: string) => Promise<OAuthClient | null>;
    saveClient: (client: OAuthClient) => Promise<void>;
  };
}

export interface CreateMCPServerOptions<
  Env = unknown,
  TSchema extends ZodTypeAny = never,
  TBindings extends BindingRegistry = BindingRegistry,
  TEnv extends Env & DefaultEnv<TSchema, TBindings> = Env &
    DefaultEnv<TSchema, TBindings>,
  State extends
    TEnv["MESH_REQUEST_CONTEXT"]["state"] = TEnv["MESH_REQUEST_CONTEXT"]["state"],
> {
  serverInfo?: Partial<Implementation> & { instructions?: string };
  before?: (env: TEnv) => Promise<void> | void;
  oauth?: OAuthConfig;
  events?: {
    handlers?: EventHandlers<TEnv, TSchema>;
  };
  configuration?: {
    onChange?: (env: TEnv, cb: OnChangeCallback<State>) => Promise<void>;
    /**
     * Fired once per connection, on the first ON_MCP_CONFIGURATION call (the
     * user's first config save). Use it to provision agents/automations via
     * the injected `createAgent` helper. Requires AGENT_SCOPES in `scopes`.
     */
    onInstall?: (env: TEnv, ctx: InstallContext) => Promise<void>;
    state?: TSchema;
    scopes?: ConfigurationScope[];
  };
  tools?:
    | Array<
        | CreatedTool
        | ((
            env: TEnv,
          ) =>
            | Promise<CreatedTool>
            | CreatedTool
            | CreatedTool[]
            | Promise<CreatedTool[]>)
      >
    | ((env: TEnv) => CreatedTool[] | Promise<CreatedTool[]>);
  prompts?:
    | Array<
        | CreatedPrompt
        | ((
            env: TEnv,
          ) =>
            | Promise<CreatedPrompt>
            | CreatedPrompt
            | CreatedPrompt[]
            | Promise<CreatedPrompt[]>)
      >
    | ((env: TEnv) => CreatedPrompt[] | Promise<CreatedPrompt[]>);
  resources?:
    | Array<
        | CreatedResource
        | ((
            env: TEnv,
          ) =>
            | Promise<CreatedResource>
            | CreatedResource
            | CreatedResource[]
            | Promise<CreatedResource[]>)
      >
    | ((env: TEnv) => CreatedResource[] | Promise<CreatedResource[]>);
}

export type Fetch<TEnv = unknown> = (
  req: Request,
  env: TEnv,
  ctx: any,
) => Promise<Response> | Response;

export interface AppContext<TEnv extends DefaultEnv = DefaultEnv> {
  env: TEnv;
  ctx: { waitUntil: (promise: Promise<unknown>) => void };
  req?: Request;
}

// TEnv is erased here because toolsFor() only reads events/configuration
// and doesn't need the full env type. Replacing `any` with a proper generic
// would require threading TEnv through toolsFor, which is a larger refactor.
type ResolvedMCPServerOptions<TSchema extends ZodTypeAny = never> =
  CreateMCPServerOptions<any, TSchema>; // eslint-disable-line @typescript-eslint/no-explicit-any

const getMeshCtx = (input: { runtimeContext: AppContext }) => {
  const ctx =
    input.runtimeContext.env.STUDIO_REQUEST_CONTEXT ??
    input.runtimeContext.env.MESH_REQUEST_CONTEXT;
  return {
    connectionId: ctx?.connectionId,
    meshUrl: ctx?.meshUrl,
    token: ctx?.token,
  };
};

const toolsFor = <TSchema extends ZodTypeAny = never>({
  events,
  configuration: { state: schema, scopes, onChange, onInstall } = {},
}: ResolvedMCPServerOptions<TSchema> = {}): CreatedTool[] => {
  const jsonSchema = schema
    ? injectBindingSchemas(z.toJSONSchema(schema) as Record<string, unknown>)
    : { type: "object", properties: {} };
  return [
    ...(onChange || onInstall || events
      ? [
          createTool({
            id: "ON_MCP_CONFIGURATION",
            description: "MCP Configuration On Change",
            inputSchema: z.object({
              state: schema ?? z.unknown(),
              scopes: z
                .array(z.string())
                .describe(
                  "Array of scopes in format 'KEY::SCOPE' (e.g., 'GMAIL::GetCurrentUser')",
                ),
              firstRun: z
                .boolean()
                .optional()
                .describe(
                  "True on the first configuration save for this connection — fires onInstall.",
                ),
              vault: z
                .object({
                  baseUrl: z.string(),
                  org: z.string(),
                  subjectConnectionId: z.string(),
                  token: z.string(),
                })
                .optional(),
            }),
            outputSchema: z.object({}),
            execute: async (input) => {
              const state = (input.context as { state: unknown })
                .state as z.infer<TSchema>;
              const vault = (input.context as { vault?: StudioVaultBootstrap })
                .vault;
              await onChange?.(input.runtimeContext.env, {
                state,
                scopes: (input.context as { scopes: string[] }).scopes,
                vault,
              });

              if (
                onInstall &&
                (input.context as { firstRun?: boolean }).firstRun
              ) {
                const { meshUrl, token, connectionId } = getMeshCtx(input);
                await onInstall(input.runtimeContext.env, {
                  createAgent: makeCreateAgent(meshUrl, token, connectionId),
                  vault,
                });
              }

              return Promise.resolve({});
            },
          }),
        ]
      : []),

    ...(events?.handlers
      ? [
          createTool({
            id: "ON_EVENTS",
            description:
              "Receive and process CloudEvents from the event bus. Returns per-event or batch results.",
            inputSchema: OnEventsInputSchema,
            outputSchema: OnEventsOutputSchema,
            execute: async (input) => {
              const env = input.runtimeContext.env;
              const state = (
                env.STUDIO_REQUEST_CONTEXT ?? env.MESH_REQUEST_CONTEXT
              )?.state as z.infer<TSchema>;
              const { connectionId } = getMeshCtx(input);
              return Event.execute(
                events.handlers!,
                input.context.events,
                env,
                state,
                connectionId,
              );
            },
          }),
        ]
      : []),
    createTool({
      id: "MCP_CONFIGURATION",
      description: "MCP Configuration",
      inputSchema: z.object({}),
      outputSchema: z.object({
        stateSchema: z.unknown(),
        scopes: z.array(z.string()).optional(),
      }),
      execute: () => {
        return Promise.resolve({
          stateSchema: jsonSchema,
          scopes: [...((scopes as string[]) ?? [])],
        });
      },
    }),
  ];
};

type CallTool = (opts: {
  toolCallId: string;
  toolCallInput: unknown;
}) => Promise<unknown>;

export type MCPServer<
  TEnv = unknown,
  TSchema extends ZodTypeAny = never,
  TBindings extends BindingRegistry = BindingRegistry,
> = {
  fetch: Fetch<TEnv & DefaultEnv<TSchema, TBindings>>;
  callTool: CallTool;
};

export const createMCPServer = <
  Env = unknown,
  TSchema extends ZodTypeAny = never,
  TBindings extends BindingRegistry = BindingRegistry,
  TEnv extends Env & DefaultEnv<TSchema, TBindings> = Env &
    DefaultEnv<TSchema, TBindings>,
>(
  options: CreateMCPServerOptions<TEnv, TSchema, TBindings>,
): MCPServer<TEnv, TSchema, TBindings> => {
  // Tool/prompt/resource definitions are resolved once on first request and
  // cached for the lifetime of the process. Tool *execution* reads per-request
  // context from State (AsyncLocalStorage) via the second `ctx` argument, so
  // reusing definitions is safe.
  type Registrations = {
    tools: CreatedTool[];
    prompts: CreatedPrompt[];
    resources: CreatedResource[];
  };

  let cached: Registrations | null = null;
  let inflightResolve: Promise<Registrations> | null = null;

  // The MCP SDK's `tools/list` handler runs `toJsonSchemaCompat()` for every
  // registered tool on every request. For MCPs with hundreds of tools that
  // dominates per-request latency (seconds, not ms). Cache the rendered
  // payload across requests within the isolate.
  let cachedListToolsResult: ListToolsResult | null = null;

  let _warnedFactoryDeprecation = false;
  const warnFactoryDeprecation = () => {
    if (!_warnedFactoryDeprecation) {
      console.warn(
        "[runtime] Passing factory functions to tools/prompts/resources is deprecated. " +
          "Pass createTool()/createPrompt()/createResource() instances directly.",
      );
      _warnedFactoryDeprecation = true;
    }
  };

  /**
   * Check whether a value is an already-created instance (has an `id` or `name` property)
   * rather than a factory function.
   */
  const isInstance = (v: unknown): boolean =>
    typeof v === "object" &&
    v !== null &&
    ("id" in v || "name" in v || "uri" in v);

  /**
   * Resolve an array that may contain both direct instances and factory functions.
   * Factories are called with `bindings` and trigger a deprecation warning.
   */
  async function resolveArray<T>(
    items: Array<unknown> | undefined,
    bindings: TEnv,
  ): Promise<T[]> {
    if (!items) return [];
    return (
      await Promise.all(
        items.flatMap(async (item) => {
          if (isInstance(item)) {
            return [item as T];
          }
          // Factory function — deprecated path
          warnFactoryDeprecation();
          const result = await (item as (env: TEnv) => unknown)(bindings);
          if (Array.isArray(result)) return result as T[];
          return [result as T];
        }),
      )
    ).flat();
  }

  const resolveRegistrations = async (
    bindings: TEnv,
  ): Promise<Registrations> => {
    if (cached) return cached;
    if (inflightResolve) return inflightResolve;

    inflightResolve = (async (): Promise<Registrations> => {
      try {
        let tools: CreatedTool[];
        if (typeof options.tools === "function") {
          warnFactoryDeprecation();
          tools = await options.tools(bindings);
        } else {
          tools = await resolveArray<CreatedTool>(options.tools, bindings);
        }

        tools.push(...toolsFor<TSchema>({ ...options }));

        let prompts: CreatedPrompt[];
        if (typeof options.prompts === "function") {
          warnFactoryDeprecation();
          prompts = await options.prompts(bindings);
        } else {
          prompts = await resolveArray<CreatedPrompt>(
            options.prompts,
            bindings,
          );
        }

        let resources: CreatedResource[];
        if (typeof options.resources === "function") {
          warnFactoryDeprecation();
          resources = await options.resources(bindings);
        } else {
          resources = await resolveArray<CreatedResource>(
            options.resources,
            bindings,
          );
        }

        const result = {
          tools,
          prompts,
          resources,
        };
        cached = result;
        return result;
      } catch (err) {
        inflightResolve = null;
        throw err;
      }
    })();

    return inflightResolve;
  };

  const registerAll = (server: McpServer, registrations: Registrations) => {
    for (const tool of registrations.tools) {
      server.registerTool(
        tool.id,
        {
          _meta: tool._meta,
          title: tool.title,
          description: tool.description,
          annotations: tool.annotations,
          // Pass the full ZodObject (not its `.shape`) so the SDK skips
          // `objectFromShape(...)` (a fresh `z.object(shape)` per tool) inside
          // `_createRegisteredTool`. The SDK's `getZodSchemaObject` returns
          // an already-built object as-is.
          inputSchema:
            tool.inputSchema && "shape" in tool.inputSchema
              ? (tool.inputSchema as ZodTypeAny)
              : z.object({}),
          outputSchema:
            tool.outputSchema &&
            typeof tool.outputSchema === "object" &&
            "shape" in tool.outputSchema
              ? (tool.outputSchema as ZodTypeAny)
              : undefined,
        },
        async (args) => {
          const ctx = createRuntimeContext();
          const result = await tool.execute(
            { context: args, runtimeContext: ctx },
            ctx,
          );

          if (
            result != null &&
            typeof result === "object" &&
            "content" in result &&
            Array.isArray(result.content) &&
            result.content.every(
              (item: unknown) =>
                item != null &&
                typeof item === "object" &&
                "type" in item &&
                typeof (item as Record<string, unknown>).type === "string",
            )
          ) {
            return result as CallToolResult;
          }

          return {
            structuredContent: result as Record<string, unknown>,
            content: [
              {
                type: "text",
                text: JSON.stringify(result),
              },
            ],
          };
        },
      );
    }

    for (const prompt of registrations.prompts) {
      server.registerPrompt(
        prompt.name,
        {
          title: prompt.title,
          description: prompt.description,
          argsSchema: prompt.argsSchema
            ? (prompt.argsSchema as unknown as z.ZodRawShape)
            : z.object({}).shape,
        },
        async (args) => {
          const ctx = createRuntimeContext();
          return await prompt.execute(
            {
              args: args as Record<string, string | undefined>,
              runtimeContext: ctx,
            },
            ctx,
          );
        },
      );
    }

    for (const resource of registrations.resources) {
      server.resource(
        resource.name,
        resource.uri,
        {
          description: resource.description,
          mimeType: resource.mimeType,
        },
        async (uri) => {
          const ctx = createRuntimeContext();
          const result = await resource.read({ uri, runtimeContext: ctx }, ctx);

          const meta =
            (result as { _meta?: Record<string, unknown> | null })._meta ??
            undefined;
          if (result.text !== undefined) {
            return {
              contents: [
                {
                  uri: result.uri,
                  mimeType: result.mimeType,
                  text: result.text,
                  ...(meta !== undefined ? { _meta: meta } : {}),
                },
              ],
            };
          } else if (result.blob !== undefined) {
            return {
              contents: [
                {
                  uri: result.uri,
                  mimeType: result.mimeType,
                  blob: result.blob,
                  ...(meta !== undefined ? { _meta: meta } : {}),
                },
              ],
            };
          }

          return {
            contents: [
              { uri: result.uri, mimeType: result.mimeType, text: "" },
            ],
          };
        },
      );
    }
  };

  const createServer = async (bindings: TEnv) => {
    await options.before?.(bindings);

    const { instructions, ...serverInfoOverrides } = options.serverInfo ?? {};
    const server = new McpServer(
      {
        ...serverInfoOverrides,
        name: serverInfoOverrides.name ?? "@deco/mcp-api",
        version: serverInfoOverrides.version ?? "1.0.0",
      },
      {
        capabilities: { tools: {}, prompts: {}, resources: {} },
        jsonSchemaValidator: sharedJsonSchemaValidator,
        ...(instructions && { instructions }),
      },
    );

    const registrations = await resolveRegistrations(bindings);
    registerAll(server, registrations);

    // Wrap the SDK-installed `tools/list` handler so the rendered payload is
    // computed once per isolate and reused across requests. The MCP Server
    // itself can't be shared across requests (its transport is single-use, see
    // `Protocol.connect`), so each request still spins up a fresh Server +
    // Transport — but the listTools render is by far the dominant cost for
    // large tool surfaces, and it's pure of request-scoped state.
    // Hardcoded per MCP spec — Zod 4 stores literal values at `_zod.def.value`,
    // not `.value`, so introspecting `ListToolsRequestSchema.shape.method` is
    // brittle across zod versions. The string is the protocol method name.
    const TOOLS_LIST_METHOD = "tools/list";
    const innerHandlers = (
      server.server as unknown as {
        _requestHandlers: Map<
          string,
          (req: unknown, extra: unknown) => Promise<unknown>
        >;
      }
    )._requestHandlers;
    const sdkListToolsHandler = innerHandlers.get(TOOLS_LIST_METHOD);
    if (sdkListToolsHandler) {
      innerHandlers.set(TOOLS_LIST_METHOD, async (req, extra) => {
        if (!cachedListToolsResult) {
          cachedListToolsResult = (await sdkListToolsHandler(
            req,
            extra,
          )) as ListToolsResult;
        }
        return cachedListToolsResult;
      });
    }

    return { server, ...registrations };
  };

  const fetch = async (req: Request, env: TEnv) => {
    const { server } = await createServer(env);
    const transport = new HttpServerTransport();

    await server.connect(transport);

    const cleanup = () => {
      try {
        transport.close?.();
      } catch {
        /* ignore */
      }
      try {
        server.close?.();
      } catch {
        /* ignore */
      }
    };

    try {
      const response = await transport.handleRequest(req);

      const contentType = response.headers.get("content-type");
      const isStreaming =
        contentType?.includes("text/event-stream") ||
        contentType?.includes("application/json-rpc");

      if (!isStreaming || !response.body) {
        cleanup();
        return response;
      }

      // Pipe the SSE body through a passthrough so that when the stream
      // finishes (server sent the response) or the client disconnects
      // (cancel), the server and transport are always cleaned up.
      const { readable, writable } = new TransformStream();
      response.body
        .pipeTo(writable)
        .catch(() => {})
        .finally(cleanup);

      return new Response(readable, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      cleanup();
      throw error;
    }
  };

  const callTool: CallTool = async ({ toolCallId, toolCallInput }) => {
    const currentState = State.getStore();
    if (!currentState) {
      throw new Error("Missing state, did you forget to call State.bind?");
    }
    const env = currentState?.env;
    const { tools } = await resolveRegistrations(
      env as TEnv & DefaultEnv<TSchema>,
    );
    const tool = tools.find((t) => t.id === toolCallId);
    const execute = tool?.execute;
    if (!execute) {
      throw new Error(
        `Tool ${toolCallId} not found or does not have an execute function`,
      );
    }

    const ctx = createRuntimeContext();
    return execute({ context: toolCallInput, runtimeContext: ctx }, ctx);
  };

  return {
    fetch,
    callTool,
  };
};
