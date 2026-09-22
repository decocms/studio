import type { Kysely } from "kysely";

/**
 * Which sandbox image a repository's sandboxes boot from.
 *
 * The default image cannot look at a Flutter app: `flutter build web` is its
 * only path to a UI, and a repo whose transitive dependencies do not compile
 * to JS has none at all. The Flutter image adds a Linux desktop toolchain and
 * a headless X server, which is ~1.3GB of apt — too much to put on the image
 * every sandbox pulls, so it is a separate image and repos opt in.
 *
 * A column rather than a flag bag: this selects infrastructure (it resolves to
 * a SandboxTemplate name), it is per-repository rather than per-org, and it is
 * the kind of value that wants an index the day someone asks which repos use
 * which image. NULL means the deployment default, so every existing row keeps
 * booting exactly as it did.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("repositories")
    .addColumn("sandbox_image", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("repositories")
    .dropColumn("sandbox_image")
    .execute();
}
