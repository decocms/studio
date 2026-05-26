import { CheckCircle, Link01 } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import { authClient } from "@/web/lib/auth-client";
import { useGitUserLink } from "@/web/hooks/collections/use-git-providers";

/**
 * Lets the calling user link (or confirm linkage of) their personal GitHub
 * identity to Studio. When linked, agents triggered by this user will act as
 * them on GitHub instead of as Decobot — this is the key fix for the original
 * "everything looks like it came from one person" impersonation problem.
 */
export function GitProviderUserLinkCard() {
  const { data: session } = authClient.useSession();
  const status = useGitUserLink(session?.user?.id);

  if (!status) return null;

  return (
    <div className="rounded-md border border-border bg-card p-4 flex items-start gap-4">
      <div className="shrink-0 mt-0.5">
        {status.linked ? (
          <CheckCircle size={20} className="text-green-600" />
        ) : (
          <Link01 size={20} className="text-muted-foreground" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">
          {status.linked
            ? "Your personal GitHub is linked"
            : "Link your personal GitHub"}
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">
          {status.linked
            ? "Agents you trigger will act as you on GitHub — issues you create show your name, not Decobot's."
            : "Until you link, agents you trigger will be blocked from GitHub write actions. Linking lets them act as you."}
        </div>
      </div>
      {!status.linked && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            // Full-page redirect — Better Auth needs the session cookie and
            // popups complicate the OAuth dance. We'll come back to this page
            // via `redirectTo`.
            window.location.href = status.linkUrl;
          }}
        >
          Link GitHub
        </Button>
      )}
    </div>
  );
}
