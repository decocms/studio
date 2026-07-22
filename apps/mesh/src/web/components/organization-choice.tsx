import { Avatar } from "@deco/ui/components/avatar.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Loading01 } from "@untitledui/icons";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

export interface OrganizationChoiceItem {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  joinMode?: "auto" | "request";
}

export interface OrganizationChoiceProps {
  organizations: OrganizationChoiceItem[];
  domain?: string;
  requestedSlugs?: Set<string>;
  onRequestedSlug?: (slug: string) => void;
  onSelected?: (organization: OrganizationChoiceItem) => void;
  onJoined?: (organization: OrganizationChoiceItem, slug: string) => void;
  onRequestCompleted?: (organization: OrganizationChoiceItem) => void;
  selectLabel?: string;
}

interface DomainJoinResult {
  success: boolean;
  slug?: string;
  error?: string;
}

interface DomainRequestJoinResult extends DomainJoinResult {
  alreadyMember: boolean;
}

async function postDomainAction<T extends DomainJoinResult>(
  url: string,
  organizationSlug: string,
  fallbackError: string,
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ organizationSlug }),
  });
  const data: T = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || fallbackError);
  }
  return data;
}

export function OrganizationChoice({
  organizations,
  domain,
  requestedSlugs,
  onRequestedSlug,
  onSelected,
  onJoined,
  onRequestCompleted,
  selectLabel = "Select",
}: OrganizationChoiceProps) {
  const [localRequestedSlugs, setLocalRequestedSlugs] = useState<Set<string>>(
    new Set(),
  );

  const markRequested = (slug: string) => {
    setLocalRequestedSlugs((prev) => new Set(prev).add(slug));
    onRequestedSlug?.(slug);
  };

  const joinOrgMutation = useMutation({
    mutationFn: async (organization: OrganizationChoiceItem) => {
      const data = await postDomainAction<DomainJoinResult>(
        "/api/auth/custom/domain-join",
        organization.slug,
        "Failed to join organization",
      );
      return { organization, slug: data.slug ?? organization.slug };
    },
    onSuccess: ({ organization, slug }) => {
      onJoined?.(organization, slug);
    },
  });

  const requestJoinMutation = useMutation({
    mutationFn: async (organization: OrganizationChoiceItem) => {
      const data = await postDomainAction<DomainRequestJoinResult>(
        "/api/auth/custom/domain-request-join",
        organization.slug,
        "Failed to request access",
      );
      return {
        organization,
        slug: data.slug,
        alreadyMember: data.alreadyMember,
      };
    },
    onSuccess: ({ organization, slug, alreadyMember }) => {
      if (alreadyMember && slug) {
        onJoined?.(organization, slug);
        return;
      }
      markRequested(organization.slug);
      onRequestCompleted?.(organization);
    },
  });

  const effectiveRequestedSlugs = new Set([
    ...(requestedSlugs ?? []),
    ...localRequestedSlugs,
  ]);
  const pendingJoinSlug = joinOrgMutation.variables?.slug ?? null;
  const pendingRequestSlug = requestJoinMutation.variables?.slug ?? null;

  return (
    <div className="grid grid-cols-1 gap-2">
      {organizations.map((org) => {
        const isJoining =
          joinOrgMutation.isPending && pendingJoinSlug === org.slug;
        const isRequesting =
          requestJoinMutation.isPending && pendingRequestSlug === org.slug;
        const hasRequested = effectiveRequestedSlugs.has(org.slug);
        const logoUrl =
          org.logo ??
          (domain
            ? `https://www.google.com/s2/favicons?domain=${domain}&sz=128`
            : null);

        return (
          <div
            key={org.id}
            className="rounded-xl card-shadow bg-background dark:bg-input/30 p-4 flex items-center gap-4"
          >
            <Avatar
              url={logoUrl ?? undefined}
              fallback={org.name.charAt(0).toUpperCase()}
              shape="square"
              size="base"
              className="h-10 w-10 shrink-0"
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{org.name}</p>
              {domain && (
                <p className="text-xs text-muted-foreground truncate">
                  @{domain}
                </p>
              )}
            </div>
            {org.joinMode === "auto" ? (
              <Button
                size="default"
                onClick={() => joinOrgMutation.mutate(org)}
                disabled={joinOrgMutation.isPending}
              >
                {isJoining ? (
                  <span className="flex items-center gap-2">
                    <Loading01 size={14} className="animate-spin" /> Joining...
                  </span>
                ) : (
                  "Join"
                )}
              </Button>
            ) : org.joinMode === "request" ? (
              hasRequested ? (
                <span className="text-xs text-muted-foreground shrink-0">
                  Request sent
                </span>
              ) : (
                <Button
                  size="default"
                  variant="outline"
                  onClick={() => requestJoinMutation.mutate(org)}
                  disabled={requestJoinMutation.isPending}
                >
                  {isRequesting ? (
                    <span className="flex items-center gap-2">
                      <Loading01 size={14} className="animate-spin" />{" "}
                      Requesting...
                    </span>
                  ) : (
                    "Request to join"
                  )}
                </Button>
              )
            ) : (
              <Button size="default" onClick={() => onSelected?.(org)}>
                {selectLabel}
              </Button>
            )}
          </div>
        );
      })}
      {joinOrgMutation.error && (
        <p className="text-xs text-destructive" role="alert">
          {joinOrgMutation.error instanceof Error
            ? joinOrgMutation.error.message
            : "Failed to join organization"}
        </p>
      )}
      {requestJoinMutation.error && (
        <p className="text-xs text-destructive" role="alert">
          {requestJoinMutation.error instanceof Error
            ? requestJoinMutation.error.message
            : "Failed to request access"}
        </p>
      )}
    </div>
  );
}
