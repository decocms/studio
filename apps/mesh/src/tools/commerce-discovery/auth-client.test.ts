import { describe, expect, test } from "bun:test";
import {
  bindCommerceDiscoveryResource,
  fetchCommerceDiscoveryAuth,
  triggerCommerceDiscoveryRun,
} from "./auth-client";

describe("fetchCommerceDiscoveryAuth", () => {
  test("upgrades the normalized domain and returns the generated client token", async () => {
    const captured: Array<{
      method: string;
      pathname: string;
      authorization: string | null;
      body: unknown;
    }> = [];

    const auth = await fetchCommerceDiscoveryAuth(
      {
        siteUrl: "https://example.com/path",
        orgId: "org_123",
        orgName: "Acme",
        email: "owner@acme.com",
        reportUrl: "https://studio.example.test/commerce-onboarding?org=acme",
      },
      {
        baseUrl: "https://commerce.example.test",
        apiKey: "master-key",
        fetchImpl: async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          captured.push({
            method: request.method,
            pathname: url.pathname,
            authorization: request.headers.get("authorization"),
            body: await request.json(),
          });

          return Response.json({
            url: "example.com",
            org_id: "org_123",
            scope: "private",
            token: "dgn_test_token",
            run: { id: "run_123", status: "running" },
          });
        },
      },
    );

    expect(auth).toEqual({ authorizationToken: "dgn_test_token" });
    expect(captured).toEqual([
      {
        method: "POST",
        pathname: "/api/v2/internal/diagnostics/example.com/upgrade",
        authorization: "Bearer master-key",
        body: {
          org_id: "org_123",
          name: "Acme",
          email: "owner@acme.com",
          report_url:
            "https://studio.example.test/commerce-onboarding?org=acme",
        },
      },
    ]);
  });

  test("requires an internal API key", async () => {
    await expect(
      fetchCommerceDiscoveryAuth(
        {
          siteUrl: "https://example.com",
          orgId: "org_123",
        },
        {
          settings: {
            commerceDiscoveryInternalApiUrl: undefined,
            commerceDiscoveryInternalApiKey: undefined,
          },
        },
      ),
    ).rejects.toThrow(
      "COMMERCE_DISCOVERY_INTERNAL_API_KEY is required to set up Commerce Discovery.",
    );
  });

  test("rejects upgrade responses without a token", async () => {
    await expect(
      fetchCommerceDiscoveryAuth(
        {
          siteUrl: "https://example.com",
          orgId: "org_123",
        },
        {
          baseUrl: "https://commerce.example.test",
          apiKey: "master-key",
          fetchImpl: async () => Response.json({ scope: "private" }),
        },
      ),
    ).rejects.toThrow(
      "Commerce Discovery auth response did not include a token.",
    );
  });
});

describe("triggerCommerceDiscoveryRun", () => {
  test("POSTs /run for the normalized domain with the org id + bearer", async () => {
    const captured: Array<{
      method: string;
      pathname: string;
      authorization: string | null;
      body: unknown;
    }> = [];

    const out = await triggerCommerceDiscoveryRun(
      { siteUrl: "https://example.com/path", orgId: "org_123" },
      {
        baseUrl: "https://commerce.example.test",
        apiKey: "master-key",
        fetchImpl: async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          captured.push({
            method: request.method,
            pathname: url.pathname,
            authorization: request.headers.get("authorization"),
            body: await request.json(),
          });
          return Response.json({
            url: "example.com",
            scope: "private",
            run: {},
          });
        },
      },
    );

    expect(out).toEqual({ triggered: true });
    expect(captured).toEqual([
      {
        method: "POST",
        pathname: "/api/v2/internal/diagnostics/example.com/run",
        authorization: "Bearer master-key",
        body: { org_id: "org_123" },
      },
    ]);
  });

  test("treats a 409 (not upgraded yet) as a soft skip, not a throw", async () => {
    const out = await triggerCommerceDiscoveryRun(
      { siteUrl: "https://example.com", orgId: "org_123" },
      {
        baseUrl: "https://commerce.example.test",
        apiKey: "master-key",
        fetchImpl: async () =>
          Response.json(
            { error: "not_upgraded_or_not_owner" },
            { status: 409 },
          ),
      },
    );
    expect(out).toEqual({ triggered: false, reason: "not_upgraded" });
  });

  test("requires an internal API key", async () => {
    await expect(
      triggerCommerceDiscoveryRun(
        { siteUrl: "https://example.com", orgId: "org_123" },
        {
          settings: {
            commerceDiscoveryInternalApiUrl: undefined,
            commerceDiscoveryInternalApiKey: undefined,
          },
        },
      ),
    ).rejects.toThrow(
      "COMMERCE_DISCOVERY_INTERNAL_API_KEY is required to set up Commerce Discovery.",
    );
  });
});

describe("bindCommerceDiscoveryResource", () => {
  test("POSTs /bindings for the normalized domain and returns the verified binding", async () => {
    const captured: Array<{
      method: string;
      pathname: string;
      authorization: string | null;
      body: unknown;
    }> = [];

    const out = await bindCommerceDiscoveryResource(
      {
        siteUrl: "https://example.com/loja",
        orgId: "org_123",
        provider: "ga4",
        resourceId: "123456789",
      },
      {
        baseUrl: "https://commerce.example.test",
        apiKey: "master-key",
        fetchImpl: async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          captured.push({
            method: request.method,
            pathname: url.pathname,
            authorization: request.headers.get("authorization"),
            body: await request.json(),
          });
          return Response.json({
            url: "example.com",
            org_id: "org_123",
            binding: {
              resource_id: "123456789",
              evidence: "https://www.example.com",
            },
          });
        },
      },
    );

    expect(out).toEqual({
      ok: true,
      resourceId: "123456789",
      evidence: "https://www.example.com",
    });
    expect(captured).toEqual([
      {
        method: "POST",
        pathname: "/api/v2/internal/diagnostics/example.com/bindings",
        authorization: "Bearer master-key",
        body: { org_id: "org_123", provider: "ga4", resource_id: "123456789" },
      },
    ]);
  });

  test("returns the pt-BR detail on a 422 verification failure (not a throw)", async () => {
    const out = await bindCommerceDiscoveryResource(
      {
        siteUrl: "https://attacker.com.br",
        orgId: "org_123",
        provider: "ga4",
        resourceId: "999",
      },
      {
        baseUrl: "https://commerce.example.test",
        apiKey: "master-key",
        fetchImpl: async () =>
          Response.json(
            {
              error: "verification_failed",
              reason: "no-match",
              detail:
                "nenhum web stream da property 999 aponta para attacker.com.br.",
            },
            { status: 422 },
          ),
      },
    );

    expect(out).toEqual({
      ok: false,
      reason: "no-match",
      detail: "nenhum web stream da property 999 aponta para attacker.com.br.",
    });
  });

  test("maps a 409 (already bound elsewhere) to an actionable pt-BR detail", async () => {
    const out = await bindCommerceDiscoveryResource(
      {
        siteUrl: "https://example.com",
        orgId: "org_123",
        provider: "gsc",
        resourceId: "sc-domain:example.com",
      },
      {
        baseUrl: "https://commerce.example.test",
        apiKey: "master-key",
        fetchImpl: async () =>
          Response.json({ error: "resource_already_bound" }, { status: 409 }),
      },
    );

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe("resource_already_bound");
      expect(out.detail).toContain("outra loja");
    }
  });

  test("throws on an unexpected status", async () => {
    await expect(
      bindCommerceDiscoveryResource(
        {
          siteUrl: "https://example.com",
          orgId: "org_123",
          provider: "ga4",
          resourceId: "1",
        },
        {
          baseUrl: "https://commerce.example.test",
          apiKey: "master-key",
          fetchImpl: async () =>
            Response.json({ error: "boom" }, { status: 500 }),
        },
      ),
    ).rejects.toThrow("Commerce Discovery auth failed");
  });

  test("requires an internal API key", async () => {
    await expect(
      bindCommerceDiscoveryResource(
        {
          siteUrl: "https://example.com",
          orgId: "org_123",
          provider: "ga4",
          resourceId: "1",
        },
        {
          settings: {
            commerceDiscoveryInternalApiUrl: undefined,
            commerceDiscoveryInternalApiKey: undefined,
          },
        },
      ),
    ).rejects.toThrow(
      "COMMERCE_DISCOVERY_INTERNAL_API_KEY is required to set up Commerce Discovery.",
    );
  });
});
