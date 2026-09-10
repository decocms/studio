import { useState } from "react";
import { toast } from "@decocms/ui/components/sonner.tsx";
import { authClient } from "@/lib/auth-client";
import { useT } from "@/i18n/use-t.ts";

/**
 * Profile avatar upload.
 *
 * The bytes go to the caller's own filesystem (`POST /api/_users/avatar`) and
 * only the resulting URL is persisted on `user.image`. That column ships
 * inline in every `/get-session` response, so a base64 data URL there bloats
 * the whole session payload — and once broke login outright by overflowing the
 * `set-auth-jwt` header. The server rejects inline data URLs for that reason;
 * this is the supported path.
 */

/** Kept in step with `MAX_AVATAR_BYTES` in `apps/api/src/file-storage/user-fs.ts`. */
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/** Kept in step with the server's `AVATAR_EXT_BY_MIME` allowlist. SVG is out. */
const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** `accept` attribute for the file input, so the picker filters up front. */
export const AVATAR_ACCEPT = ACCEPTED_TYPES.join(",");

async function errorMessage(res: Response): Promise<string> {
  try {
    return ((await res.json()) as { error?: string }).error ?? "";
  } catch {
    return "";
  }
}

export function useAvatarUpload() {
  const t = useT();
  const [isUploading, setIsUploading] = useState(false);

  /** Uploads the file and points `user.image` at it. Returns the stored URL. */
  const uploadAvatar = async (file: File): Promise<string | null> => {
    if (!ACCEPTED_TYPES.includes(file.type)) {
      toast.error(t("settings.profile.avatarUnsupportedType"));
      return null;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      toast.error(t("settings.profile.avatarTooLarge"));
      return null;
    }

    setIsUploading(true);
    try {
      const res = await fetch("/api/_users/avatar", {
        method: "POST",
        headers: { "content-type": file.type },
        body: file,
      });
      if (!res.ok) throw new Error(await errorMessage(res));

      const { url } = (await res.json()) as { url: string };
      await authClient.updateUser({ image: url });
      toast.success(t("settings.profile.avatarUpdated"));
      return url;
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t("settings.profile.avatarUploadError"),
      );
      return null;
    } finally {
      setIsUploading(false);
    }
  };

  /**
   * Clears the avatar. `user.image` is nulled first so a failure to delete the
   * bytes leaves an unreferenced file rather than a broken image URL.
   */
  const removeAvatar = async (): Promise<boolean> => {
    setIsUploading(true);
    try {
      await authClient.updateUser({ image: null });
      await fetch("/api/_users/avatar", { method: "DELETE" });
      toast.success(t("settings.profile.avatarRemoved"));
      return true;
    } catch {
      toast.error(t("settings.profile.avatarUploadError"));
      return false;
    } finally {
      setIsUploading(false);
    }
  };

  return { uploadAvatar, removeAvatar, isUploading };
}
