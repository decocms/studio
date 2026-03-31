import { RegistryItemStorage } from "./registry-item";
import { PublishRequestStorage } from "./publish-request";
import { PublishApiKeyStorage } from "./publish-api-key";
import { MonitorRunStorage, MonitorResultStorage } from "./monitor-run";
import { MonitorConnectionStorage } from "./monitor-connection";

export * from "./types";

export interface RegistryStorage {
  items: RegistryItemStorage;
  publishRequests: PublishRequestStorage;
  publishApiKeys: PublishApiKeyStorage;
  monitorRuns: MonitorRunStorage;
  monitorResults: MonitorResultStorage;
  monitorConnections: MonitorConnectionStorage;
}

export {
  RegistryItemStorage,
  PublishRequestStorage,
  PublishApiKeyStorage,
  MonitorRunStorage,
  MonitorResultStorage,
  MonitorConnectionStorage,
};
