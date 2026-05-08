/**
 * Test scaffolding for thread tool tests. Mirrors the manual context
 * construction in `connection/connection-tools.test.ts`, but only wires the
 * storage modules the thread tools touch (threads, virtualMcps).
 */

import { vi } from "bun:test";
import {
  createTestDatabase,
  closeTestDatabase,
  type TestDatabase,
} from "../../database/test-db";
import {
  createTestSchema,
  seedCommonTestFixtures,
} from "../../storage/test-helpers";
import { CredentialVault } from "../../encryption/credential-vault";
import {
  SqlThreadStorage,
  OrgScopedThreadStorage,
} from "../../storage/threads";
import { VirtualMCPStorage } from "../../storage/virtual";
import type { BoundAuthClient, MeshContext } from "../../core/mesh-context";

const ORG_ID = "org_test";
const USER_ID = "user_test";

export interface ThreadTestEnv {
  database: TestDatabase;
  ctx: MeshContext;
  orgId: string;
  userId: string;
  close: () => Promise<void>;
}

const createMockBoundAuth = (): BoundAuthClient =>
  ({
    hasPermission: vi.fn().mockResolvedValue(true),
    organization: {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      addMember: vi.fn(),
      removeMember: vi.fn(),
      listMembers: vi.fn(),
      updateMemberRole: vi.fn(),
    },
    apiKey: {
      create: vi.fn(),
      list: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  }) as unknown as BoundAuthClient;

export async function buildThreadTestContext(): Promise<ThreadTestEnv> {
  const database = await createTestDatabase();
  await createTestSchema(database.db);
  await seedCommonTestFixtures(database.db);

  const vault = new CredentialVault(CredentialVault.generateKey());
  const sqlThreads = new SqlThreadStorage(database.db);
  const threads = new OrgScopedThreadStorage(sqlThreads, ORG_ID);
  const virtualMcps = new VirtualMCPStorage(database.db);

  const ctx = {
    timings: {
      measure: async <T>(_name: string, cb: () => Promise<T>) => await cb(),
    },
    auth: {
      user: {
        id: USER_ID,
        email: "[email protected]",
        name: "T",
        role: "admin",
      },
    },
    organization: { id: ORG_ID, slug: "test-org", name: "Test Org" },
    storage: {
      threads,
      virtualMcps,
      // Stub the rest — thread tools don't touch these.
      connections: null as never,
      organizationSettings: null as never,
      monitoring: null as never,
      users: null as never,
      tags: null as never,
      virtualMcpPluginConfigs: null as never,
      aiProviderKeys: null as never,
      oauthPkceStates: null as never,
      automations: null as never,
      orgSsoConfig: null as never,
      orgSsoSessions: null as never,
      triggerCallbackTokens: null as never,
      registry: null as never,
      brandContext: null as never,
      organizationDomains: null as never,
    },
    vault,
    authInstance: null as never,
    boundAuth: createMockBoundAuth(),
    access: {
      granted: () => true,
      check: async () => {},
      grant: () => {},
      setToolName: () => {},
    } as never,
    db: database.db,
    tracer: {
      startActiveSpan: (
        _name: string,
        _opts: unknown,
        fn: (span: unknown) => unknown,
      ) =>
        fn({
          setStatus: () => {},
          recordException: () => {},
          end: () => {},
        }),
    } as never,
    meter: {
      createHistogram: () => ({ record: () => {} }),
      createCounter: () => ({ add: () => {} }),
    } as never,
    baseUrl: "https://mesh.example.com",
    metadata: { requestId: "req_test", timestamp: new Date() },
    eventBus: null as never,
    objectStorage: null as never,
    aiProviders: null as never,
    createMCPProxy: vi.fn().mockResolvedValue({}),
    getOrCreateClient: vi.fn().mockResolvedValue({}),
    pendingRevalidations: [],
  } as unknown as MeshContext;

  return {
    database,
    ctx,
    orgId: ORG_ID,
    userId: USER_ID,
    close: () => closeTestDatabase(database),
  };
}
