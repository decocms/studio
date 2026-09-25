import type { GitProviderKind } from "@decocms/shared/git-providers";
import { ChevronRight } from "@untitledui/icons";
import { Avatar } from "@decocms/ui/components/avatar.tsx";
import { GitProviderIcon } from "@/components/icons/git-provider-icon";
import type { GitAccount } from "@/hooks/use-git-providers";

export function ProviderIcon({
  provider,
  className,
}: {
  provider: GitProviderKind;
  className?: string;
}) {
  return (
    <GitProviderIcon provider={provider} size={16} className={className} />
  );
}

export function GitAccountAvatar({
  account,
  className,
}: {
  account: GitAccount;
  className: string;
}) {
  return (
    <Avatar
      url={account.avatarUrl?.trim() || undefined}
      fallback={
        <ProviderIcon
          provider={account.type}
          className="text-muted-foreground"
        />
      }
      shape="circle"
      size="sm"
      className={className}
      muted
    />
  );
}

/** An account Studio can actually mint credentials for. */
export function serviceableAccounts(
  accounts: GitAccount[] | undefined,
): GitAccount[] {
  return (accounts ?? []).filter((a) => a.status === "active" && a.servable);
}

export function GitAccountList({
  title,
  accounts,
  onSelect,
  disabled,
}: {
  title: string;
  accounts: GitAccount[];
  onSelect: (account: GitAccount) => void;
  disabled: boolean;
}) {
  return (
    <div className="py-2">
      <p className="px-4 py-2 text-xs font-medium text-muted-foreground">
        {title}
      </p>
      {accounts.map((account) => (
        <button
          key={account.id}
          type="button"
          onClick={() => onSelect(account)}
          disabled={disabled}
          className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-accent transition-colors focus-visible:outline-none focus-visible:bg-accent disabled:opacity-50"
        >
          <GitAccountAvatar account={account} className="size-8" />
          <span className="flex-1 min-w-0">
            <span className="block text-sm font-medium truncate">
              {account.login}
            </span>
            <span className="block text-xs text-muted-foreground truncate">
              {account.host}
            </span>
          </span>
          <ChevronRight size={16} className="text-muted-foreground" />
        </button>
      ))}
    </div>
  );
}
