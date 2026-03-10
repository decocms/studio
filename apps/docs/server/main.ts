import { withRuntime } from "@decocms/runtime";
import { createAssetHandler } from "@decocms/runtime/asset-server";

interface Env {
  ASSETS?: {
    fetch: (req: Request) => Promise<Response>;
  };
}

const LATEST = "2026-03-10";
const PREVIOUS = "2025-10-10";

const rootRedirects: Record<string, string> = {
  "/": `/${LATEST}/en/mcp-mesh/quickstart`,
  "/latest": `/${LATEST}/en/mcp-mesh/quickstart`,
  [`/${LATEST}`]: `/${LATEST}/en/mcp-mesh/quickstart`,
  [`/${PREVIOUS}`]: `/${PREVIOUS}/en/introduction`,
  "/en": `/${LATEST}/en/mcp-mesh/quickstart`,
  "/pt-br": `/${LATEST}/pt-br/mcp-mesh/quickstart`,
  [`/${LATEST}/en`]: `/${LATEST}/en/mcp-mesh/quickstart`,
  [`/${LATEST}/pt-br`]: `/${LATEST}/pt-br/mcp-mesh/quickstart`,
  [`/${PREVIOUS}/en`]: `/${PREVIOUS}/en/introduction`,
  [`/${PREVIOUS}/pt-br`]: `/${PREVIOUS}/pt-br/introduction`,
};

const runtime = withRuntime<Env>({
  fetch: async (req, env) => {
    const url = new URL(req.url);
    if (rootRedirects[url.pathname]) {
      return Response.redirect(
        new URL(rootRedirects[url.pathname], req.url),
        302,
      );
    }

    // Redirect /latest/* to actual latest version
    if (url.pathname.startsWith("/latest/") || url.pathname === "/latest") {
      const newPath = `${url.pathname.replace(/^\/latest/, `/${LATEST}`)}${url.search}`;
      return Response.redirect(new URL(newPath, req.url), 302);
    }

    const assetsHandler =
      env.ASSETS?.fetch ??
      createAssetHandler({
        env: "development",
      });

    return (
      (await assetsHandler(req)) ?? new Response("Not found", { status: 404 })
    );
  },
});

export default runtime;
