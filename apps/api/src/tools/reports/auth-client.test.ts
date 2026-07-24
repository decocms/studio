import { describe, expect, test } from "bun:test";
import {
  bindCommerceDiscoveryResource,
  CommerceDiscoveryClaimError,
  commerceDiscoveryClaimMessagePtBr,
  fetchCommerceDiscoveryAuth,
  fetchCommerceDiscoveryConnectionStatus,
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

  async function captureClaimError(
    fetchImpl: () => Promise<Response>,
    input: Partial<{ siteUrl: string; email: string }> = {},
  ): Promise<CommerceDiscoveryClaimError> {
    try {
      await fetchCommerceDiscoveryAuth(
        {
          siteUrl: input.siteUrl ?? "https://example.com",
          orgId: "org_123",
          ...(input.email ? { email: input.email } : {}),
        },
        {
          baseUrl: "https://commerce.example.test",
          apiKey: "master-key",
          fetchImpl,
        },
      );
    } catch (error) {
      if (error instanceof CommerceDiscoveryClaimError) return error;
      throw error;
    }
    throw new Error("expected fetchCommerceDiscoveryAuth to reject");
  }

  test("maps a 403 ownership_unverified to a friendly pt-BR message with email + domain", async () => {
    const error = await captureClaimError(
      async () =>
        Response.json(
          { error: "ownership_unverified", reason: "domain_mismatch" },
          { status: 403 },
        ),
      { siteUrl: "https://loja.com.br/path", email: "someone@gmail.com" },
    );

    expect(error.code).toBe("ownership_unverified");
    expect(error.message).toContain("someone@gmail.com");
    expect(error.message).toContain("loja.com.br");
    expect(error.message).toContain("permissão para reivindicar");
  });

  test("maps a 409 already_claimed_by_other_org to a distinct support message", async () => {
    const error = await captureClaimError(
      async () =>
        Response.json(
          { error: "already_claimed_by_other_org" },
          { status: 409 },
        ),
      { email: "owner@example.com" },
    );

    expect(error.code).toBe("already_claimed_by_other_org");
    expect(error.message).toContain("outra organização");
    expect(error.message).toContain("suporte");
    // Must NOT tell the user to just retry.
    expect(error.message).not.toContain("Tente novamente");
  });

  test("maps an unrecognized/generic upgrade failure to the generic fallback", async () => {
    const error = await captureClaimError(async () =>
      Response.json({ error: "missing_org_id" }, { status: 400 }),
    );

    expect(error.code).toBe("unknown");
    expect(error.message).toContain(
      "Não foi possível configurar o Commerce Discovery",
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

describe("commerceDiscoveryClaimMessagePtBr", () => {
  test("ownership_unverified interpolates email + domain and guides to a different email / domain alias", () => {
    const message = commerceDiscoveryClaimMessagePtBr("ownership_unverified", {
      email: "someone@gmail.com",
      domain: "loja.com.br",
    });
    expect(message).toContain("someone@gmail.com");
    expect(message).toContain("loja.com.br");
    expect(message).toContain("e-mail do domínio do site");
    expect(message).toContain("autorizar seu domínio");
  });

  test("ownership_unverified degrades gracefully without email/domain", () => {
    const message = commerceDiscoveryClaimMessagePtBr("ownership_unverified");
    expect(message).toContain("Este e-mail");
    expect(message).toContain("este site");
  });

  test("already_claimed_by_other_org points to support and does NOT suggest retrying", () => {
    const message = commerceDiscoveryClaimMessagePtBr(
      "already_claimed_by_other_org",
    );
    expect(message).toContain("outra organização");
    expect(message).toContain("suporte");
    expect(message).not.toContain("Tente novamente");
  });

  test("the two main codes produce genuinely different messages", () => {
    expect(commerceDiscoveryClaimMessagePtBr("ownership_unverified")).not.toBe(
      commerceDiscoveryClaimMessagePtBr("already_claimed_by_other_org"),
    );
  });

  test("unknown falls back to a generic friendly message", () => {
    const message = commerceDiscoveryClaimMessagePtBr("unknown");
    expect(message).toContain(
      "Não foi possível configurar o Commerce Discovery",
    );
    expect(message).toContain("Tente novamente");
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

  test("forwards github_repo in the body when provided", async () => {
    let body: unknown;
    await triggerCommerceDiscoveryRun(
      {
        siteUrl: "https://example.com",
        orgId: "org_123",
        githubRepo: "deco-sites/fila-store",
      },
      {
        baseUrl: "https://commerce.example.test",
        apiKey: "master-key",
        fetchImpl: async (input, init) => {
          body = await new Request(input, init).json();
          return Response.json({
            url: "example.com",
            scope: "private",
            run: {},
          });
        },
      },
    );
    expect(body).toEqual({
      org_id: "org_123",
      github_repo: "deco-sites/fila-store",
    });
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

describe("fetchCommerceDiscoveryConnectionStatus", () => {
  test("GETs the status for the normalized domain + org and returns providers", async () => {
    const captured: Array<{ method: string; url: string }> = [];

    const out = await fetchCommerceDiscoveryConnectionStatus(
      { siteUrl: "https://example.com/loja", orgId: "org_123" },
      {
        baseUrl: "https://commerce.example.test",
        apiKey: "master-key",
        fetchImpl: async (input, init) => {
          const request = new Request(input, init);
          captured.push({ method: request.method, url: request.url });
          return Response.json({
            url: "example.com",
            org_id: "org_123",
            providers: {
              ga4: { connected: true, via: "sa", resource: "123456789" },
              gsc: { connected: false, via: null, resource: null },
              vtex: { connected: true, via: "oauth", resource: null },
            },
          });
        },
      },
    );

    expect(out.ga4).toEqual({
      connected: true,
      via: "sa",
      resource: "123456789",
    });
    expect(out.gsc?.connected).toBe(false);
    expect(captured).toEqual([
      {
        method: "GET",
        url: "https://commerce.example.test/api/v2/internal/diagnostics/example.com/connections/status?org_id=org_123",
      },
    ]);
  });

  test("treats a 409 (never upgraded) as everything disconnected, not a throw", async () => {
    const out = await fetchCommerceDiscoveryConnectionStatus(
      { siteUrl: "https://example.com", orgId: "org_123" },
      {
        baseUrl: "https://commerce.example.test",
        apiKey: "master-key",
        fetchImpl: async () =>
          Response.json({ error: "not_upgraded" }, { status: 409 }),
      },
    );
    expect(out).toEqual({});
  });
});
