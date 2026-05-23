/**
 * Workflow engine migrations.
 *
 * Hosts decide when to apply them — mesh runs them through the ServerPlugin
 * registration system, standalone embeds run them at boot. The shape is
 * structurally compatible with `ServerPluginMigration` from
 * `@decocms/bindings/server-plugin` so the mesh adapter can pass this array
 * through unchanged.
 */

import type { Kysely } from "kysely";
import { migration as migration001 } from "./001-workflows";
import { migration as migration002 } from "./002-execution-list-index";
import { migration as migration003 } from "./003-retry-and-input-schema";

export interface EngineMigration {
  name: string;
  up: (db: Kysely<unknown>) => Promise<void>;
  down: (db: Kysely<unknown>) => Promise<void>;
}

export const migrations: EngineMigration[] = [
  migration001,
  migration002,
  migration003,
];
