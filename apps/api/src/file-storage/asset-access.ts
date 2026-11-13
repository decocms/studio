import type { AccessControl } from "../core/access-control";

// Preserve existing action grants without granting bucket administration to
// asset editors. FILE_CONFIG_UPDATE historically authorized browser uploads
// only; it must not start authorizing URL imports or object deletion.
const ASSET_WRITE_PERMISSIONS = {
  "browser-upload": [
    "ASSETS_MANAGE",
    "FILE_OBJECT_UPLOAD",
    "FILE_CONFIG_UPDATE",
  ],
  import: ["ASSETS_MANAGE", "FILE_OBJECT_UPLOAD"],
  delete: ["ASSETS_MANAGE", "FILE_OBJECT_DELETE"],
} as const;

export function checkAssetWrite(
  access: AccessControl,
  operation: keyof typeof ASSET_WRITE_PERMISSIONS,
): Promise<void> {
  return access.check(...ASSET_WRITE_PERMISSIONS[operation]);
}
