import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@decocms/ui/components/sonner.tsx";
import { authClient } from "@/lib/auth-client";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";

/**
 * Profile avatars, stored in the caller's own filesystem.
 *
 * Bytes go to `/api/_users/avatar` and only the resulting URL is persisted on
 * `user.image`. That column ships inline in every `/get-session` response, so
 * a base64 data URL there bloats the whole session payload — and once broke
 * login outright by overflowing the `set-auth-jwt` header. The server rejects
 * inline data URLs for that reason; this is the supported path.
 *
 * The last few pictures are kept so re-picking one is a click. Only the one in
 * use is world-readable — the rest are private to their owner, which is why
 * the thumbnails here load for you and for nobody else.
 */

/** Kept in step with `MAX_AVATAR_BYTES` in `apps/api/src/file-storage/user-fs.ts`. */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/** Kept in step with the server's `AVATAR_EXT_BY_MIME` allowlist. SVG is out. */
export const AVATAR_ACCEPT = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

export interface StoredAvatar {
  path: string;
  url: string;
  current: boolean;
  updatedAt: string;
}

async function errorMessage(res: Response): Promise<string> {
  try {
    return ((await res.json()) as { error?: string }).error ?? "";
  } catch {
    return "";
  }
}

async function expectOk(res: Response): Promise<Response> {
  if (!res.ok) throw new Error(await errorMessage(res));
  return res;
}

/** The caller's stored pictures, newest first. */
export function useAvatarHistory(enabled: boolean) {
  return useQuery({
    queryKey: KEYS.userAvatars(),
    enabled,
    queryFn: async (): Promise<StoredAvatar[]> => {
      const res = await expectOk(await fetch("/api/_users/avatars"));
      return ((await res.json()) as { avatars: StoredAvatar[] }).avatars;
    },
  });
}

export function useAvatarActions() {
  const t = useT();
  const queryClient = useQueryClient();

  /** Both the picture list and the session's `image` change together. */
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: KEYS.userAvatars() }),
      authClient.getSession({ query: { disableCookieCache: true } }),
    ]);
  };

  const withToast = async (
    run: () => Promise<void>,
    success: string,
  ): Promise<boolean> => {
    try {
      await run();
      await refresh();
      toast.success(success);
      return true;
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t("settings.profile.avatarUploadError"),
      );
      return false;
    }
  };

  /** Uploads the cropped bytes and points `user.image` at them. */
  const uploadAvatar = async (blob: Blob): Promise<string | null> => {
    let url: string | null = null;
    const ok = await withToast(async () => {
      const res = await expectOk(
        await fetch("/api/_users/avatar", {
          method: "POST",
          headers: { "content-type": blob.type || "image/webp" },
          body: blob,
        }),
      );
      url = ((await res.json()) as { url: string }).url;
      await authClient.updateUser({ image: url });
    }, t("settings.profile.avatarUpdated"));
    return ok ? url : null;
  };

  /** Re-picks a picture already in the history. */
  const selectAvatar = (path: string) =>
    withToast(async () => {
      const res = await expectOk(
        await fetch("/api/_users/avatar/select", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path }),
        }),
      );
      const { url } = (await res.json()) as { url: string };
      await authClient.updateUser({ image: url });
    }, t("settings.profile.avatarUpdated"));

  /** Deletes one stored picture. The current one is not offered for deletion. */
  const deleteStoredAvatar = (path: string) =>
    withToast(async () => {
      await expectOk(
        await fetch(`/api/_users/avatar?path=${encodeURIComponent(path)}`, {
          method: "DELETE",
        }),
      );
    }, t("settings.profile.avatarDeleted"));

  /**
   * Clears the avatar and the whole history. `user.image` is nulled first so a
   * failure to delete the bytes leaves unreferenced files rather than a broken
   * image URL.
   */
  const removeAvatar = () =>
    withToast(async () => {
      await authClient.updateUser({ image: null });
      await expectOk(await fetch("/api/_users/avatar", { method: "DELETE" }));
    }, t("settings.profile.avatarRemoved"));

  return { uploadAvatar, selectAvatar, deleteStoredAvatar, removeAvatar };
}
