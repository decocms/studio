/**
 * User Sandbox Plugin - Migrations Index
 *
 * Exports all plugin migrations for registration with the core migration system.
 */

import type { ServerPluginMigration } from "@decocms/bindings/server-plugin";
import { migration as migration001 } from "./001-user-sandbox";

export const migrations: ServerPluginMigration[] = [migration001];
