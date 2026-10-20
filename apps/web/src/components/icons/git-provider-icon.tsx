import type { GitProviderKind } from "@decocms/shared/git-providers";
import { BitbucketIcon } from "./bitbucket-icon";
import { GitHubIcon } from "./github-icon";
import { GitLabIcon } from "./gitlab-icon";

const ICONS: Record<
  GitProviderKind,
  (props: { size?: number; className?: string }) => React.ReactNode
> = {
  github: GitHubIcon,
  gitlab: GitLabIcon,
  bitbucket: BitbucketIcon,
};

/** The one place a provider kind becomes a logo, so no surface can fall back to the wrong one. */
export function GitProviderIcon({
  provider,
  size = 16,
  className,
}: {
  provider: GitProviderKind;
  size?: number;
  className?: string;
}) {
  const Icon = ICONS[provider];
  return <Icon size={size} className={className} />;
}
