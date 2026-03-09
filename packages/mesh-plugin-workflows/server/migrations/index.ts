/**
 * Workflows Plugin - Migrations Index
 *
 * Exports all plugin migrations for registration with the core migration system.
 */

import type { ServerPluginMigration } from "@decocms/bindings/server-plugin";
import { migration as migration001 } from "./001-workflows";
import { migration as migration002 } from "./002-execution-list-index";

export const migrations: ServerPluginMigration[] = [migration001, migration002];
