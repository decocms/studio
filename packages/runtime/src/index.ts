/* oxlint-disable no-explicit-any */
import { decodeJwt } from "jose";
import { z } from "zod";
import {
  BindingRegistry,
  initializeBindings,
  ResolvedBindings,
} from "./bindings.ts";
import { type CORSOptions, handlePreflight, withCORS } from "./cors.ts";
import { createOAuthHandlers } from "./oauth.ts";
import { State } from "./state.ts";
import {
  createMCPServer,
  type CreateMCPServerOptions,
  MCPServer,
} from "./tools.ts";
export {
  createPrompt,
  createPublicPrompt,
  type Prompt,
  type PromptArgsRawShape,
  type PromptExecutionContext,
  type CreatedPrompt,
  type GetPromptResult,
  createResource,
  createPublicResource,
  type Resource,
  type ResourceExecutionContext,
  type ResourceContents,
  type CreatedResource,
} from "./tools.ts";
import type { Binding } from "./wrangler.ts";
export { proxyConnectionForId, BindingOf } from "./bindings.ts";
export { type CORSOptions, type CORSOrigin } from "./cors.ts";
export {
  createMCPFetchStub,
  type CreateStubAPIOptions,
  type ToolBinder,
} from "./mcp.ts";

export type { BindingRegistry } from "./bindings.ts";

export interface DefaultEnv<
  TSchema extends z.ZodTypeAny = any,
  TBindings extends BindingRegistry = BindingRegistry,
> {
  MESH_REQUEST_CONTEXT: RequestContext<TSchema, TBindings>;
  MESH_APP_DEPLOYMENT_ID: string;
  IS_LOCAL: boolean;
  MESH_URL?: string;
  MESH_RUNTIME_TOKEN?: string;
  MESH_APP_NAME?: string;
  [key: string]: unknown;
}

export interface BindingsObject {
  bindings?: Binding[];
}

export const MCPBindings = {
  parse: (bindings?: string): Binding[] => {
    if (!bindings) return [];
    try {
      return JSON.parse(atob(bindings)) as Binding[];
    } catch {
      return [];
    }
  },
  stringify: (bindings: Binding[]): string => {
    return btoa(JSON.stringify(bindings));
  },
};

export interface UserDefaultExport<
  TUserEnv = Record<string, unknown>,
  TSchema extends z.ZodTypeAny = never,
  TBindings extends BindingRegistry = BindingRegistry,
  TEnv extends TUserEnv & DefaultEnv<TSchema, TBindings> = TUserEnv &
    DefaultEnv<TSchema, TBindings>,
> extends CreateMCPServerOptions<TEnv, TSchema, TBindings> {
  fetch?: (req: Request, env: TEnv, ctx: any) => Promise<Response> | Response;
  /**
   * CORS configuration options.
   * Set to `false` to disable CORS handling entirely.
   */
  cors?: CORSOptions | false;
}

export interface User {
  id: string;
  email: string;
  workspace: string;
  user_metadata: {
    avatar_url: string;
    full_name: string;
    picture: string;
    [key: string]: unknown;
  };
}

export interface RequestContext<
  TSchema extends z.ZodTypeAny = any,
  TBindings extends BindingRegistry = BindingRegistry,
> {
  state: ResolvedBindings<z.infer<TSchema>, TBindings>;
  token: string;
  meshUrl: string;
  authorization?: string | null;
  ensureAuthenticated: (options?: {
    workspaceHint?: string;
  }) => User | undefined;
  callerApp?: string;
  connectionId?: string;
  organizationId?: string;
}

const withDefaultBindings = ({
  env,
  server,
  url,
}: {
  env: DefaultEnv;
  server: MCPServer<any, any>;
  url?: string;
}) => {
  env["SELF"] = new Proxy(
    {},
    {
      get: (_, prop) => {
        if (prop === "toJSON") {
          return null;
        }

        return async (args: unknown) => {
          return await server.callTool({
            toolCallId: prop as string,
            toolCallInput: args,
          });
        };
      },
    },
  );

  env["IS_LOCAL"] =
    (url?.startsWith("http://localhost") ||
      url?.startsWith("http://127.0.0.1")) ??
    false;
};

export class UnauthorizedError extends Error {
  constructor(
    message: string,
    public redirectTo: URL,
  ) {
    super(message);
    this.name = "UnauthorizedError";
  }
}

const AUTHENTICATED = (user?: unknown) => () => {
  return {
    ...((user as User) ?? {}),
  } as User;
};

export const withBindings = <TEnv>({
  env: _env,
  server,
  tokenOrContext,
  url,
  authToken,
}: {
  env: TEnv;
  server: MCPServer<TEnv, any, any>;
  // token is x-mesh-token
  tokenOrContext?: string | RequestContext;
  // authToken is the authorization header
  authToken?: string | null;
  url?: string;
}): TEnv => {
  const env = _env as DefaultEnv<any>;
  const authorization = authToken ? authToken.split(" ")[1] : undefined;

  let context;
  if (typeof tokenOrContext === "string") {
    const decoded = decodeJwt(tokenOrContext);
    // Support both new JWT format (fields directly on payload) and legacy format (nested in metadata)
    const metadata =
      (decoded.metadata as {
        state?: Record<string, unknown>;
        meshUrl?: string;
        connectionId?: string;
        organizationId?: string;
      }) ?? {};

    context = {
      authorization,
      state: decoded.state ?? metadata.state ?? {},
      token: tokenOrContext,
      meshUrl: (decoded.meshUrl as string) ?? metadata.meshUrl,
      connectionId: (decoded.connectionId as string) ?? metadata.connectionId,
      organizationId:
        (decoded.organizationId as string) ?? metadata.organizationId,
      ensureAuthenticated: AUTHENTICATED(decoded.user ?? decoded.sub),
    } as RequestContext<any>;
  } else if (typeof tokenOrContext === "object") {
    context = tokenOrContext;
    const decoded = decodeJwt(tokenOrContext.token);
    // Support both new JWT format (fields directly on payload) and legacy format (nested in metadata)
    const metadata =
      (decoded.metadata as {
        state?: Record<string, unknown>;
        meshUrl?: string;
        connectionId?: string;
      }) ?? {};
    const appName = decoded.appName as string | undefined;
    context.authorization ??= authorization;
    context.callerApp = appName;
    context.connectionId ??=
      (decoded.connectionId as string) ?? metadata.connectionId;
    context.ensureAuthenticated = AUTHENTICATED(decoded.user ?? decoded.sub);
  } else {
    context = {
      state: {},
      authorization,
      token: undefined,
      meshUrl: undefined,
      connectionId: undefined,
      ensureAuthenticated: () => {
        throw new Error("Unauthorized");
      },
    } as unknown as RequestContext<any>;
  }

  env.MESH_REQUEST_CONTEXT = context;
  context.state = initializeBindings(context);

  withDefaultBindings({
    env,
    server,
    url,
  });

  return env as TEnv;
};

const DEFAULT_CORS_OPTIONS = {
  origin: (origin: string) => {
    // Allow localhost and configured origins
    if (origin.includes("localhost") || origin.includes("127.0.0.1")) {
      return origin;
    }
    // TODO: Configure allowed origins from environment
    return origin;
  },
  credentials: true,
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "mcp-protocol-version"],
};

export const withRuntime = <
  TUserEnv,
  TSchema extends z.ZodTypeAny = never,
  TBindings extends BindingRegistry = BindingRegistry,
  TEnv extends TUserEnv & DefaultEnv<TSchema, TBindings> = TUserEnv &
    DefaultEnv<TSchema, TBindings>,
>(
  userFns: UserDefaultExport<TUserEnv, TSchema, TBindings>,
) => {
  const server = createMCPServer<TUserEnv, TSchema, TBindings>(userFns);
  const corsOptions = userFns.cors ?? DEFAULT_CORS_OPTIONS;
  const oauth = userFns.oauth;
  const oauthHandlers = oauth ? createOAuthHandlers(oauth) : null;

  const fetcher = async (req: Request, env: TEnv, ctx: any) => {
    const url = new URL(req.url);

    // OAuth routes (when configured)
    if (oauthHandlers) {
      // Protected resource metadata (RFC9728) - both paths MUST be supported
      if (
        url.pathname === "/.well-known/oauth-protected-resource" ||
        url.pathname === "/mcp/.well-known/oauth-protected-resource"
      ) {
        return oauthHandlers.handleProtectedResourceMetadata(req);
      }

      // Authorization server metadata (RFC8414)
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return oauthHandlers.handleAuthorizationServerMetadata(req);
      }

      // Authorization endpoint - redirects to external OAuth provider
      if (url.pathname === "/authorize") {
        return oauthHandlers.handleAuthorize(req);
      }

      // OAuth callback - receives code from external OAuth provider
      if (url.pathname === "/oauth/callback") {
        return oauthHandlers.handleOAuthCallback(req);
      }

      // Token endpoint - exchanges code for tokens
      if (url.pathname === "/token" && req.method === "POST") {
        return oauthHandlers.handleToken(req);
      }

      // Dynamic client registration (RFC7591)
      if (
        (url.pathname === "/register" || url.pathname === "/mcp/register") &&
        req.method === "POST"
      ) {
        return oauthHandlers.handleClientRegistration(req);
      }
    }

    // MCP endpoint
    if (url.pathname === "/mcp") {
      if (req.method === "GET") {
        return new Response("Method not allowed", { status: 405 });
      }
      // If OAuth is configured, require authentication
      if (oauthHandlers && !oauthHandlers.hasAuth(req)) {
        // Clone request to check method without consuming the original body
        const clonedReq = req.clone();
        try {
          const body = (await clonedReq.json()) as { method?: string };
          // Allow tools/list to pass without auth
          if (body?.method !== "tools/list") {
            return oauthHandlers.createUnauthorizedResponse(req);
          }
        } catch {
          // If body parsing fails, require auth
          return oauthHandlers.createUnauthorizedResponse(req);
        }
      }

      return server.fetch(req, env, ctx);
    }

    if (url.pathname.startsWith("/mcp/call-tool")) {
      const toolCallId = url.pathname.split("/").pop();
      if (!toolCallId) {
        return new Response("Not found", { status: 404 });
      }
      const toolCallInput = await req.json();
      const result = await server.callTool({
        toolCallId,
        toolCallInput,
      });

      if (result instanceof Response) {
        return result;
      }

      return new Response(JSON.stringify(result), {
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    return (
      userFns.fetch?.(req, env, ctx) ||
      new Response("Not found", { status: 404 })
    );
  };

  return {
    fetch: async (req: Request, env: TEnv, ctx?: any) => {
      if (new URL(req.url).pathname === "/_healthcheck") {
        return new Response("OK", { status: 200 });
      }
      // Handle CORS preflight (OPTIONS) requests
      if (corsOptions !== false && req.method === "OPTIONS") {
        const options = corsOptions ?? {};
        return handlePreflight(req, options);
      }

      const bindings = withBindings({
        authToken: req.headers.get("authorization") ?? null,
        env: { ...process.env, ...env },
        server,
        tokenOrContext: req.headers.get("x-mesh-token") ?? undefined,
        url: req.url,
      });

      const response = await State.run(
        { req, env: bindings, ctx },
        async () => await fetcher(req, bindings, ctx),
      );

      // Add CORS headers to response
      if (corsOptions !== false) {
        const options = corsOptions ?? {};
        return withCORS(response, req, options);
      }

      return response;
    },
  };
};

export {
  type Contract,
  type Migration,
  type WranglerConfig,
} from "./wrangler.ts";
