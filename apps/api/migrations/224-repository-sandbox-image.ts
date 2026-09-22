import type { Kysely } from "kysely";

/**
 * Which sandbox image a repository's sandboxes boot from.
 *
 * The default image cannot run a mobile app: its only path to a Flutter UI is
 * `flutter build web`, which neither compiles every dependency graph nor runs
 * native-only plugins like Firebase. The Android image adds an emulator and
 * needs KVM nodes — too heavy, and too specific, for the image every sandbox
 * pulls — so it is a separate image and repos opt in.
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
