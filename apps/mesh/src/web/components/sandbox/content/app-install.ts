import {
  appBlockId,
  appResolveType,
  type AppCatalogEntry,
} from "./app-catalog";
import { decoBlockFilePath } from "@/web/components/sections-editor/deco-block-key";

export interface AppLocator {
  app: string;
  vendor: string;
}

export function appShimFilePath(vendor: string, app: string): string {
  return `apps/${vendor}/${app}.ts`;
}

/** Mirrors admin `USE_NEW_APP_ALIAS_FOR_EXPORTING = false` export path. */
export function buildAppShimFileContent(appName: string): string {
  const pathToExport = `apps/${appName}/mod.ts`;
  return `export { default } from "${pathToExport}";\nexport * from "${pathToExport}";\n`;
}

export function resolveInstallBlockKey(locator: AppLocator): string {
  if (locator.vendor === "decohub") return locator.app;
  return appBlockId(locator.vendor, locator.app);
}

export function buildInstallBlockData(
  locator: AppLocator,
  appProps?: Record<string, unknown>,
): Record<string, unknown> {
  if (locator.vendor === "decohub") {
    return {
      __resolveType: `decohub/apps/${locator.app}.ts`,
      ...appProps,
    };
  }
  return {
    __resolveType: appResolveType(locator.vendor, locator.app),
    ...appProps,
  };
}

export function buildInstallWrites(
  locator: AppLocator,
  appProps?: Record<string, unknown>,
): Array<{ path: string; content: string }> {
  const blockKey = resolveInstallBlockKey(locator);
  const writes: Array<{ path: string; content: string }> = [
    {
      path: decoBlockFilePath(blockKey),
      content: JSON.stringify(
        buildInstallBlockData(locator, appProps),
        null,
        2,
      ),
    },
  ];

  if (locator.vendor !== "decohub") {
    writes.unshift({
      path: appShimFilePath(locator.vendor, locator.app),
      content: buildAppShimFileContent(locator.app),
    });
  }

  return writes;
}

export function isDecohubLocator(locator: AppLocator): boolean {
  return locator.vendor === "decohub";
}

/** Paths to delete on uninstall (admin `generateAppUninstallPatches`). */
export function buildUninstallPaths(
  locator: AppLocator,
  blockKey: string,
  blockData: Record<string, unknown> | null,
): string[] {
  const decohub =
    isDecohubLocator(locator) ||
    typeof blockData?.__resolveType !== "string" ||
    String(blockData.__resolveType).startsWith("decohub/apps/");

  const blockPath = decoBlockFilePath(blockKey);
  if (decohub) return [blockPath];

  return [blockPath, appShimFilePath(locator.vendor, locator.app)];
}

export function catalogEntryLocator(entry: AppCatalogEntry): AppLocator {
  return { app: entry.app, vendor: entry.vendor };
}

/** Commit message for persisting app install/uninstall to git. */
export function appInstallCommitMessage(
  action: "install" | "uninstall",
  locator: AppLocator,
): string {
  return `feat(apps): ${action} ${locator.app}`;
}
