import { setupComponentTest } from "../../test/setup"; // happy-dom + jest-dom matchers
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import type { Prompt } from "@modelcontextprotocol/sdk/types.js";

setupComponentTest();

// Mocked dependencies — reset per test.
const mockGetPrompt =
  mock<
    (
      client: unknown,
      name: string,
      args?: Record<string, string>,
    ) => Promise<{
      messages: Array<{
        role: "user";
        content: { type: "text"; text: string };
      }>;
    }>
  >();
const mockWriteStoredAutosend = mock<(...args: unknown[]) => unknown>();
const mockCreate = mock<(args: unknown) => Promise<unknown>>();
const mockSetTaskId = mock<(id: string, vmcp?: string) => void>();

mock.module("@decocms/mesh-sdk", () => ({
  getPrompt: (...args: Parameters<typeof mockGetPrompt>) =>
    mockGetPrompt(...args),
  useMCPClient: () => ({}) as unknown,
  useProjectContext: () => ({
    org: { id: "org-id", slug: "org-slug" },
    locator: "loc",
  }),
}));

mock.module("@/web/lib/autosend", () => ({
  writeStoredAutosend: (...args: unknown[]) => mockWriteStoredAutosend(...args),
}));

mock.module("@/web/layouts/shell-layout", () => ({
  usePanelActions: () => ({
    setTaskId: mockSetTaskId,
    createNewTask: async () => {},
  }),
}));

mock.module("@/web/components/chat/store/hooks", () => ({
  useThreadActions: () => ({ create: mockCreate, hide: () => {} }),
}));

import { useStartThreadFromPrompt } from "./use-start-thread-from-prompt";

const promptNoArgs: Prompt = {
  name: "brand-manager-set-up",
  description: "Set up your brand",
};

const promptWithArgs: Prompt = {
  name: "needs-input",
  description: "Needs input",
  arguments: [{ name: "url", required: true }],
};

beforeEach(() => {
  mockGetPrompt.mockReset();
  mockWriteStoredAutosend.mockReset();
  mockCreate.mockReset();
  mockSetTaskId.mockReset();
});

afterEach(() => {
  mockGetPrompt.mockReset();
  mockWriteStoredAutosend.mockReset();
  mockCreate.mockReset();
  mockSetTaskId.mockReset();
});

describe("useStartThreadFromPrompt", () => {
  it("for prompts with no arguments, resolves and autosends immediately", async () => {
    mockGetPrompt.mockResolvedValueOnce({
      messages: [
        { role: "user", content: { type: "text", text: "hello brand" } },
      ],
    });
    mockCreate.mockResolvedValueOnce({});

    const { result } = renderHook(() =>
      useStartThreadFromPrompt({ agentId: "vm-brand" }),
    );

    await act(async () => {
      await result.current.start(promptNoArgs);
    });

    expect(mockGetPrompt).toHaveBeenCalledTimes(1);
    expect(mockGetPrompt.mock.calls[0]?.[1]).toBe("brand-manager-set-up");
    expect(mockWriteStoredAutosend).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const createArgs = mockCreate.mock.calls[0]?.[0] as {
      id: string;
      virtual_mcp_id: string;
    };
    expect(createArgs.virtual_mcp_id).toBe("vm-brand");
    expect(mockSetTaskId).toHaveBeenCalledWith(createArgs.id, "vm-brand", {
      autosend: true,
    });
  });

  it("for prompts with arguments, opens the args dialog and does NOT autosend until submitted", async () => {
    const { result } = renderHook(() =>
      useStartThreadFromPrompt({ agentId: "vm-brand" }),
    );

    await act(async () => {
      await result.current.start(promptWithArgs);
    });

    expect(mockGetPrompt).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(result.current.dialogPrompt?.name).toBe("needs-input");
  });
});
