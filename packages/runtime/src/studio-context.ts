interface StudioUrlOptions {
  studioUrl?: string;
  /** @deprecated Use `studioUrl` instead. */
  meshUrl?: string;
}

interface StudioRequestContextEnv<TContext> {
  STUDIO_REQUEST_CONTEXT?: TContext;
  /** @deprecated Use `STUDIO_REQUEST_CONTEXT` instead. */
  MESH_REQUEST_CONTEXT?: TContext;
}

interface StudioEnvironmentAliases extends StudioRequestContextEnv<unknown> {
  STUDIO_APP_DEPLOYMENT_ID?: string;
  /** @deprecated Use `STUDIO_APP_DEPLOYMENT_ID` instead. */
  MESH_APP_DEPLOYMENT_ID?: string;
  STUDIO_URL?: string;
  /** @deprecated Use `STUDIO_URL` instead. */
  MESH_URL?: string;
  STUDIO_RUNTIME_TOKEN?: string;
  /** @deprecated Use `STUDIO_RUNTIME_TOKEN` instead. */
  MESH_RUNTIME_TOKEN?: string;
  STUDIO_APP_NAME?: string;
  /** @deprecated Use `STUDIO_APP_NAME` instead. */
  MESH_APP_NAME?: string;
}

/**
 * Resolve the Studio URL from the canonical option before its legacy alias.
 */
export function resolveStudioUrl({
  studioUrl,
  meshUrl,
}: StudioUrlOptions): string | undefined {
  return studioUrl ?? meshUrl;
}

/**
 * Resolve the injected request context from the canonical environment key
 * before its legacy alias.
 */
export function resolveStudioRequestContext<TContext>(
  env: StudioRequestContextEnv<TContext>,
): TContext | undefined {
  return env.STUDIO_REQUEST_CONTEXT ?? env.MESH_REQUEST_CONTEXT;
}

/**
 * Mirror canonical environment values to their legacy aliases and vice versa.
 * Canonical Studio values win whenever both forms are present.
 */
export function synchronizeStudioEnvironmentAliases<TEnv extends object>(
  env: TEnv,
): TEnv {
  const aliases = env as TEnv & StudioEnvironmentAliases;
  const requestContext = resolveStudioRequestContext(aliases);
  if (requestContext !== undefined) {
    aliases.STUDIO_REQUEST_CONTEXT = requestContext;
    aliases.MESH_REQUEST_CONTEXT = requestContext;
  }

  const deploymentId =
    aliases.STUDIO_APP_DEPLOYMENT_ID ?? aliases.MESH_APP_DEPLOYMENT_ID;
  if (deploymentId !== undefined) {
    aliases.STUDIO_APP_DEPLOYMENT_ID = deploymentId;
    aliases.MESH_APP_DEPLOYMENT_ID = deploymentId;
  }

  const studioUrl = aliases.STUDIO_URL ?? aliases.MESH_URL;
  if (studioUrl !== undefined) {
    aliases.STUDIO_URL = studioUrl;
    aliases.MESH_URL = studioUrl;
  }

  const runtimeToken =
    aliases.STUDIO_RUNTIME_TOKEN ?? aliases.MESH_RUNTIME_TOKEN;
  if (runtimeToken !== undefined) {
    aliases.STUDIO_RUNTIME_TOKEN = runtimeToken;
    aliases.MESH_RUNTIME_TOKEN = runtimeToken;
  }

  const appName = aliases.STUDIO_APP_NAME ?? aliases.MESH_APP_NAME;
  if (appName !== undefined) {
    aliases.STUDIO_APP_NAME = appName;
    aliases.MESH_APP_NAME = appName;
  }

  return env;
}
