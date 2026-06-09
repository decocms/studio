import type { BoundObjectStorage } from "../../object-storage/bound-object-storage";
import {
  createHttpObjectStorage,
  type CreateHttpObjectStorageOptions,
} from "../sources";

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface RemoteObjectStorageSource {
  kind: "http";
  baseUrl: string;
  headers: Record<string, string>;
  expiresAt: number;
}

interface CreateRemoteObjectStorageOptions {
  baseUrl: string;
  headers?: Record<string, string>;
  fetch?: FetchFn;
}

export function createRemoteObjectStorage(
  options: CreateRemoteObjectStorageOptions,
): BoundObjectStorage {
  return createHttpObjectStorage(
    options satisfies CreateHttpObjectStorageOptions,
  );
}
