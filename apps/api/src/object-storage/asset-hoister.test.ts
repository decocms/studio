import { describe, expect, it } from "bun:test";
import type { ConnectionEntity } from "@decocms/shared/sdk/types";
import type { BoundObjectStorage } from "./bound-object-storage";
import { decorateStorageWithAssetHoisting } from "./asset-hoister";
import type {
  ConnectionStoragePort,
  VirtualMCPStoragePort,
} from "../storage/ports";

const PNG_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z8AARQAFAAH+AlV8AAAAAElFTkSuQmCC";

describe("decorateStorageWithAssetHoisting", () => {
  it("hoists inline assets on connection createNew", async () => {
    const uploads: Array<{ key: string; contentType?: string }> = [];
    const objectStorage = {
      put: async (key: string, _body: string | Uint8Array, options) => {
        uploads.push({ key, contentType: options?.contentType });
        return {};
      },
    } as BoundObjectStorage;

    let createNewData: Partial<ConnectionEntity> | undefined;
    const connections = {
      createNew: async (data: Partial<ConnectionEntity>) => {
        createNewData = data;
        return data as ConnectionEntity;
      },
    } as ConnectionStoragePort;

    const storage = {
      connections,
      virtualMcps: {} as VirtualMCPStoragePort,
    };

    decorateStorageWithAssetHoisting(storage, {
      objectStorage,
      baseUrl: "https://studio.test",
      orgSlug: "acme",
    });

    await storage.connections.createNew({
      icon: PNG_DATA_URI,
      metadata: { ui: { icon: PNG_DATA_URI } },
    });

    expect(uploads).toHaveLength(2);
    expect(uploads.every((upload) => upload.contentType === "image/png")).toBe(
      true,
    );
    expect(createNewData?.icon).toStartWith(
      "https://studio.test/api/acme/files/connection-icons/",
    );
    expect(
      (createNewData?.metadata as { ui: { icon: string } }).ui.icon,
    ).toStartWith("https://studio.test/api/acme/files/connection-icons/");
  });
});
