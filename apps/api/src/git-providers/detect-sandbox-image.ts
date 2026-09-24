import type { RepoRef, SandboxImage } from "@decocms/shared/git-providers";
import type { GitProviderClient } from "./types";

/**
 * The sandbox image a newly linked repository should boot from, read off its
 * files. `undefined` means "no opinion": the row keeps its default, and a
 * repository owner can still pick an image in settings.
 *
 * Detection never fails a link: a provider error is no opinion too. A
 * detected image the cluster does not render still degrades to the default at
 * claim time, so a wrong guess costs nothing but the pick.
 */
export async function detectSandboxImage(
  client: Pick<GitProviderClient, "readFile">,
  repo: RepoRef,
): Promise<SandboxImage | undefined> {
  try {
    // A Flutter app with an Android project can only be QA'd unmodified on
    // an emulator. pubspec.yaml first: most repos stop after this one call.
    if ((await client.readFile(repo, "pubspec.yaml")) === null) {
      return undefined;
    }
    for (const path of [
      "android/settings.gradle",
      "android/settings.gradle.kts",
    ]) {
      if ((await client.readFile(repo, path)) !== null) return "android";
    }
  } catch {
    return undefined;
  }
  return undefined;
}
