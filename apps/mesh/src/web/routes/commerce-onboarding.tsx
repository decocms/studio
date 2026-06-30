import { AuthSplitLayout } from "@/web/components/auth-split-layout";
import { OrganizationChoice } from "@/web/components/organization-choice";
import RequiredAuthLayout from "@/web/layouts/required-auth-layout";
import {
  invalidateOrganizationListCache,
  useActiveOrganizations,
} from "@/web/lib/auth-client";
import { Button } from "@deco/ui/components/button.tsx";
import { useMutation } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Loading01 } from "@untitledui/icons";
import { useRef, useState } from "react";

interface CommerceOrganization {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  joinMode?: "auto" | "request";
}

interface EnsureOrganizationResponse {
  success: boolean;
  status?:
    | "created"
    | "joined"
    | "already_has_organization"
    | "ambiguous"
    | "skipped";
  organization?: CommerceOrganization;
  organizations?: CommerceOrganization[];
  domain?: string | null;
  reason?: string;
  error?: string;
}

export default function CommerceOnboardingRoute() {
  return (
    <RequiredAuthLayout>
      <CommerceOnboardingPage />
    </RequiredAuthLayout>
  );
}

function CommerceOnboardingPage() {
  const { org: requestedOrgSlug } = useSearch({ from: "/commerce-onboarding" });
  const navigate = useNavigate();
  const organizationsQuery = useActiveOrganizations();
  const [selectedOrg, setSelectedOrg] = useState<CommerceOrganization | null>(
    null,
  );
  const [settledEnsureResult, setSettledEnsureResult] =
    useState<EnsureOrganizationResponse | null>(null);

  const activeOrganizations: CommerceOrganization[] =
    organizationsQuery.data?.map((org: CommerceOrganization) => ({
      id: org.id,
      name: org.name,
      slug: org.slug,
      logo: org.logo ?? null,
    })) ?? [];

  const ensureOrganizationMutation = useMutation({
    mutationFn: async (): Promise<EnsureOrganizationResponse> => {
      const res = await fetch("/api/auth/custom/ensure-organization", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      const data = (await res.json()) as EnsureOrganizationResponse;
      if (
        data.success &&
        (data.status === "created" ||
          data.status === "joined" ||
          data.status === "already_has_organization") &&
        data.organization
      ) {
        invalidateOrganizationListCache();
      }
      return data;
    },
    retry: false,
    onSuccess: (data) => {
      setSettledEnsureResult(data);
    },
  });

  if (organizationsQuery.isPending) {
    return (
      <AuthSplitLayout>
        <LoadingState label="Preparing commerce onboarding..." />
      </AuthSplitLayout>
    );
  }

  if (organizationsQuery.error) {
    return (
      <CommerceErrorState
        title="We could not load your organizations"
        description="Retry to continue commerce setup from this page."
        actionLabel="Retry"
        onRetry={() => organizationsQuery.refetch()}
      />
    );
  }

  if (selectedOrg) {
    return <CommerceSetup org={selectedOrg} />;
  }

  const requestedOrg = requestedOrgSlug
    ? activeOrganizations.find((org) => org.slug === requestedOrgSlug)
    : null;

  if (requestedOrg) {
    return <CommerceSetup org={requestedOrg} />;
  }

  if (activeOrganizations.length === 1 && activeOrganizations[0]) {
    return <CommerceSetup org={activeOrganizations[0]} />;
  }

  if (activeOrganizations.length > 1) {
    return (
      <AuthSplitLayout>
        <div className="grid gap-10">
          <CommerceHeader
            title="Choose an organization"
            description="Select where commerce diagnostics should continue."
          />
          <OrganizationChoice
            organizations={activeOrganizations}
            selectLabel="Continue"
            onSelected={(organization) => setSelectedOrg(organization)}
          />
        </div>
      </AuthSplitLayout>
    );
  }

  if (!settledEnsureResult) {
    return (
      <EnsureOrganizationRecovery
        mutation={ensureOrganizationMutation}
        onRetry={() => {
          ensureOrganizationMutation.reset();
          ensureOrganizationMutation.mutate();
        }}
      />
    );
  }

  const ensureResult = settledEnsureResult;

  if (
    ensureResult?.success &&
    (ensureResult.status === "created" ||
      ensureResult.status === "joined" ||
      ensureResult.status === "already_has_organization") &&
    ensureResult.organization
  ) {
    return <CommerceSetup org={ensureResult.organization} />;
  }

  if (
    ensureResult?.status === "ambiguous" &&
    ensureResult.organizations &&
    ensureResult.organizations.length > 0
  ) {
    return (
      <AuthSplitLayout>
        <div className="grid gap-10">
          <CommerceHeader
            title="Choose an organization"
            description="Your email can access more than one organization. Choose where commerce setup should continue."
          />
          <OrganizationChoice
            organizations={ensureResult.organizations}
            domain={ensureResult.domain ?? undefined}
            onJoined={(organization, slug) => {
              invalidateOrganizationListCache();
              setSelectedOrg({ ...organization, slug });
              navigate({
                to: "/commerce-onboarding",
                search: { org: slug },
              });
            }}
          />
        </div>
      </AuthSplitLayout>
    );
  }

  return (
    <CommerceErrorState
      title="Commerce onboarding needs support"
      description={
        ensureResult?.error ??
        "We could not determine a commerce organization for this account."
      }
      actionLabel="Try again"
      onRetry={() => {
        setSettledEnsureResult(null);
        ensureOrganizationMutation.reset();
        ensureOrganizationMutation.mutate();
      }}
    />
  );
}

function EnsureOrganizationRecovery({
  mutation,
  onRetry,
}: {
  mutation: ReturnType<typeof useMutation<EnsureOrganizationResponse, Error>>;
  onRetry: () => void;
}) {
  const startedRef = useRef(false);

  const triggerRecovery = (node: HTMLDivElement | null) => {
    if (!node || startedRef.current) return;
    startedRef.current = true;
    mutation.mutate();
  };

  if (mutation.error) {
    return (
      <CommerceErrorState
        title="Commerce onboarding is unavailable"
        description="We could not prepare an organization for commerce setup. Retry from this page or contact support."
        actionLabel="Retry"
        onRetry={onRetry}
      />
    );
  }

  return (
    <AuthSplitLayout>
      <div ref={triggerRecovery}>
        <LoadingState label="Preparing your commerce workspace..." />
      </div>
    </AuthSplitLayout>
  );
}

function CommerceHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="grid gap-10">
      <img
        src="/logos/deco logo.svg"
        alt="Deco"
        className="h-12 w-12 dark:hidden"
      />
      <img
        src="/logos/deco logo negative.svg"
        alt="Deco"
        className="h-12 w-12 hidden dark:block"
      />
      <div className="space-y-2">
        <h1 className="text-2xl font-medium leading-8">{title}</h1>
        <p className="text-base text-muted-foreground leading-6">
          {description}
        </p>
      </div>
    </div>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div
      className="flex items-center gap-2 py-4"
      role="status"
      aria-live="polite"
    >
      <Loading01 size={14} className="animate-spin text-muted-foreground" />
      <span className="text-sm text-muted-foreground">{label}</span>
    </div>
  );
}

function CommerceErrorState({
  title,
  description,
  actionLabel,
  onRetry,
}: {
  title: string;
  description: string;
  actionLabel: string;
  onRetry: () => void;
}) {
  return (
    <AuthSplitLayout>
      <div className="grid gap-10">
        <CommerceHeader title={title} description={description} />
        <Button type="button" size="xl" className="w-full" onClick={onRetry}>
          {actionLabel}
        </Button>
      </div>
    </AuthSplitLayout>
  );
}

function CommerceSetup({ org }: { org: CommerceOrganization }) {
  return (
    <AuthSplitLayout>
      <div className="grid gap-10">
        <CommerceHeader
          title="Commerce diagnostics"
          description={`Commerce setup will continue for ${org.name}.`}
        />
        <div className="rounded-xl card-shadow bg-background dark:bg-input/30 p-4">
          <p className="text-sm font-medium">{org.name}</p>
          <p className="text-xs text-muted-foreground">/{org.slug}</p>
        </div>
      </div>
    </AuthSplitLayout>
  );
}
