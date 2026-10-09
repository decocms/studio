import type { StudioContext } from "@/core/studio-context";

/** Just what the chat tools' handlers touch, with the org's tiers on one key. */
export function chatToolContext(
  overrides: Record<string, unknown> = {},
): StudioContext {
  const stored = new Map<string, Uint8Array>();
  return {
    organization: { id: "org_1", slug: "acme" },
    auth: { user: { id: "user_1" } },
    access: { check: async () => {}, setToolName: () => {} },
    storage: {
      organizationSettings: {
        get: async () => ({
          simple_mode: {
            tiers: {
              image: { keyId: "key_1", modelId: "image-model" },
              web_search: { keyId: "key_1", modelId: "search-model" },
              deep_research: { keyId: "key_1", modelId: "research-model" },
            },
          },
        }),
      },
      aiProviderKeys: {
        list: async () => [{ id: "key_1", providerId: "openrouter" }],
      },
      threads: {
        get: async (id: string) =>
          id === "thrd_1" ? { id, virtual_mcp_id: "vmcp_1" } : null,
      },
    },
    aiProviders: { listModels: async () => [] },
    objectStorage: {
      put: async (key: string, body: Uint8Array) => {
        stored.set(key, body);
      },
      getBytes: async (key: string) => {
        const bytes = stored.get(key);
        if (!bytes) throw new Error(`no object ${key}`);
        return bytes;
      },
    },
    ...overrides,
  } as unknown as StudioContext;
}
