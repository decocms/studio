import type { ConnectionEntity } from "@decocms/mesh-sdk";

export interface ConnectionGroup {
  key: string;
  serviceName: string;
  icon: string | null;
  instances: ConnectionEntity[];
}

export function groupConnections(
  connections: ConnectionEntity[],
): ConnectionGroup[] {
  const grouped = new Map<string, ConnectionGroup>();

  for (const conn of connections) {
    if (!conn.app_name) {
      // Solo group — keyed by connection id
      const key = `__solo__${conn.id}`;
      grouped.set(key, {
        key,
        serviceName: conn.title,
        icon: conn.icon ?? null,
        instances: [conn],
      });
    } else {
      const existing = grouped.get(conn.app_name);
      if (existing) {
        existing.instances.push(conn);
      } else {
        grouped.set(conn.app_name, {
          key: conn.app_name,
          serviceName: conn.app_name,
          icon: conn.icon ?? null,
          instances: [conn],
        });
      }
    }
  }

  const groups = Array.from(grouped.values());

  // Sort: multi-instance groups first, then singles — within each tier, alphabetically
  groups.sort((a, b) => {
    const aIsMulti = a.instances.length > 1;
    const bIsMulti = b.instances.length > 1;

    if (aIsMulti && !bIsMulti) return -1;
    if (!aIsMulti && bIsMulti) return 1;

    return a.serviceName.localeCompare(b.serviceName);
  });

  return groups;
}
