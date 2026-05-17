/**
 * Pod registry for multi-pod tests.
 *
 * One source of truth for which mesh services exist, what their compose
 * service names are, and which host port they expose. Tests pick a pod by
 * name (`PODS.MESH_1`) and `client.ts` / `pod.ts` look up the port or
 * service from this map.
 *
 * Keep in sync with `docker-compose.yml` — adding a pod means appending it
 * here and to the compose file.
 */

export type PodName = "mesh-1" | "mesh-2" | "mesh-3";

export interface PodInfo {
  /** Compose service name (used by docker compose CLI). */
  service: PodName;
  /** Host port that maps to the pod's internal 3000. */
  port: number;
  /** Base URL the test process uses to reach this pod. */
  baseUrl: string;
}

export const PODS: Record<string, PodInfo> = {
  MESH_1: { service: "mesh-1", port: 13001, baseUrl: "http://127.0.0.1:13001" },
  MESH_2: { service: "mesh-2", port: 13002, baseUrl: "http://127.0.0.1:13002" },
  MESH_3: { service: "mesh-3", port: 13003, baseUrl: "http://127.0.0.1:13003" },
} as const;

export const ALL_PODS: PodInfo[] = Object.values(PODS);
