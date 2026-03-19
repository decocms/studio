import { authClient } from "@/web/lib/auth-client";
import { setCurrentOrgId } from "@/web/lib/org-store";
import { useNavigate } from "@tanstack/react-router";
import { EntityCard } from "@deco/ui/components/entity-card.tsx";
import { EntityGrid } from "@deco/ui/components/entity-grid.tsx";
import { AlertCircle, Plus, Check, XClose, SearchMd } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Suspense, useState, useDeferredValue, useContext } from "react";
import { CreateOrganizationDialog } from "./create-organization-dialog";
import { AuthUIContext } from "@daveyplate/better-auth-ui";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

interface Invitation {
  id: string;
  organizationId: string;
  organizationName?: string;
  organizationSlug?: string;
  email: string;
  role: string;
  status: string;
  expiresAt: Date;
  inviterId: string;
}

function InvitationCard({ invitation }: { invitation: Invitation }) {
  const [isAccepting, setIsAccepting] = useState(false);
  const [isRejecting, setIsRejecting] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const handleAccept = async () => {
    setIsAccepting(true);
    try {
      const result = await authClient.organization.acceptInvitation({
        invitationId: invitation.id,
      });

      if (result.error) {
        toast.error(result.error.message);
        setIsAccepting(false);
      } else {
        // Set the new org as active to update session and get org data.
        const setActiveResult = await authClient.organization.setActive({
          organizationId: invitation.organizationId,
        });

        // Keep the per-tab org store in sync with the explicit switch.
        if (setActiveResult?.data?.id) {
          setCurrentOrgId(setActiveResult.data.id);
        }

        if (setActiveResult?.data?.slug) {
          toast.success("Invitation accepted!");
          navigate({ to: "/$org", params: { org: setActiveResult.data.slug } });
        } else {
          toast.success("Invitation accepted! Redirecting...");
          navigate({ to: "/" });
        }
      }
    } catch {
      toast.error("Failed to accept invitation");
      setIsAccepting(false);
    }
  };

  const handleReject = async () => {
    setIsRejecting(true);
    try {
      const result = await authClient.organization.rejectInvitation({
        invitationId: invitation.id,
      });

      if (result.error) {
        toast.error(result.error.message);
        setIsRejecting(false);
      } else {
        toast.success("Invitation rejected");
        // Just refetch to remove the card
        await queryClient.invalidateQueries();
        setIsRejecting(false);
      }
    } catch {
      toast.error("Failed to reject invitation");
      setIsRejecting(false);
    }
  };

  const orgName = invitation.organizationName || invitation.organizationId;

  return (
    <EntityCard className="border-dashed">
      <EntityCard.Header>
        <EntityCard.AvatarSection>
          <EntityCard.Avatar
            url=""
            fallback={orgName}
            size="lg"
            objectFit="contain"
          />
        </EntityCard.AvatarSection>
        <EntityCard.Content>
          <EntityCard.Subtitle>You've been invited to join</EntityCard.Subtitle>
          <EntityCard.Title>{orgName}</EntityCard.Title>
        </EntityCard.Content>
      </EntityCard.Header>
      <EntityCard.Footer className="border-t border-dashed">
        <div className="flex h-3.5 items-center gap-2 w-full">
          <Button
            onClick={handleAccept}
            disabled={isAccepting || isRejecting}
            className="flex-1"
            size="sm"
          >
            {isAccepting ? (
              "Accepting..."
            ) : (
              <>
                <Check size={16} />
                Accept
              </>
            )}
          </Button>
          <Button
            variant="outline"
            onClick={handleReject}
            disabled={isAccepting || isRejecting}
            className="flex-1"
            size="sm"
          >
            {isRejecting ? (
              "Declining..."
            ) : (
              <>
                <XClose size={16} />
                Decline
              </>
            )}
          </Button>
        </div>
      </EntityCard.Footer>
    </EntityCard>
  );
}

function InvitationsGrid({ query }: { query?: string }) {
  const authUi = useContext(AuthUIContext);
  const { data: _invitations } = authUi.hooks.useListUserInvitations();

  const invitations = (_invitations ?? []) as Invitation[];

  // Filter to only show pending invitations that haven't expired
  // Better Auth returns all invitations but accept/reject will fail for expired ones
  const pendingInvitations = invitations.filter(
    (inv) => inv.status === "pending" && new Date(inv.expiresAt) > new Date(),
  );

  // Filter invitations based on search query
  const filteredInvitations = !query
    ? pendingInvitations
    : (() => {
        const searchLower = query.toLowerCase();
        return pendingInvitations.filter(
          (inv) =>
            inv.organizationName?.toLowerCase().includes(searchLower) ||
            inv.organizationId.toLowerCase().includes(searchLower),
        );
      })();

  if (filteredInvitations.length === 0) {
    return null;
  }

  return (
    <div className="mb-16">
      <h2 className="text-lg font-medium pb-2 border-b border-border/50 mb-6 px-2">
        Invitations
      </h2>
      <EntityGrid columns={{ sm: 2, md: 3, lg: 4 }}>
        {filteredInvitations.map((invitation) => (
          <InvitationCard key={invitation.id} invitation={invitation} />
        ))}
      </EntityGrid>
    </div>
  );
}

function OrganizationsGrid({ query }: { query?: string }) {
  const { data: organizations } = authClient.useListOrganizations();
  const navigate = useNavigate();

  // Filter organizations based on search query
  const filteredOrganizations = !organizations
    ? []
    : !query
      ? organizations
      : (() => {
          const searchLower = query.toLowerCase();
          return organizations.filter(
            (org) =>
              org.name.toLowerCase().includes(searchLower) ||
              org.slug.toLowerCase().includes(searchLower),
          );
        })();

  if (!organizations || organizations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <div className="text-sm text-muted-foreground text-center">
          No organizations yet. Create your first organization to get started.
        </div>
      </div>
    );
  }

  if (filteredOrganizations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <div className="text-sm text-muted-foreground text-center">
          No organizations found matching "{query}".
        </div>
      </div>
    );
  }

  return (
    <EntityGrid columns={{ sm: 2, md: 3, lg: 4 }}>
      {filteredOrganizations.map((org) => (
        <EntityCard
          key={org.id}
          onNavigate={() =>
            navigate({ to: "/$org", params: { org: org.slug } })
          }
        >
          <EntityCard.Header>
            <EntityCard.AvatarSection>
              <EntityCard.Avatar
                url={org.logo || ""}
                fallback={org.name}
                size="lg"
                objectFit="contain"
              />
            </EntityCard.AvatarSection>
            <EntityCard.Content>
              <EntityCard.Subtitle>@{org.slug}</EntityCard.Subtitle>
              <EntityCard.Title>{org.name}</EntityCard.Title>
            </EntityCard.Content>
          </EntityCard.Header>
          <EntityCard.Footer>
            <div className="flex h-3.5 items-center text-xs text-muted-foreground">
              Created:{" "}
              {new Date(org.createdAt).toLocaleDateString(undefined, {
                year: "numeric",
                month: "short",
                day: "numeric",
              })}
            </div>
          </EntityCard.Footer>
        </EntityCard>
      ))}
    </EntityGrid>
  );
}

function ErrorState({ error }: { error: Error }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
      <AlertCircle size={24} className="text-destructive" />
      <div className="text-sm text-muted-foreground text-center">
        Error loading organizations: {error.message}
      </div>
    </div>
  );
}

export function OrganizationsHome() {
  const { error, isPending } = authClient.useListOrganizations();
  const [searchQuery, setSearchQuery] = useState("");
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const deferredQuery = useDeferredValue(searchQuery);

  if (isPending) {
    return (
      <div className="max-w-6xl mx-auto p-8">
        <div className="@container">
          <EntityGrid.Skeleton count={8} columns={{ sm: 2, md: 3, lg: 4 }} />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-6xl mx-auto p-8">
        <ErrorState error={error} />
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto p-8">
      <div className="@container">
        <Suspense fallback={null}>
          <InvitationsGrid query={deferredQuery} />
        </Suspense>
        <div>
          <div className="flex items-center justify-between pb-2 border-b border-border/50 mb-6 px-2">
            <h2 className="text-lg font-medium">My organizations</h2>
            <div className="flex items-center gap-3">
              <div className="relative">
                <SearchMd
                  size={14}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  className="pl-8 h-8 w-52 border-none shadow-none focus-visible:ring-0"
                  placeholder="Search organizations..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <Button size="sm" onClick={() => setIsCreateDialogOpen(true)}>
                <Plus size={16} />
                <span>New organization</span>
              </Button>
            </div>
          </div>
          <Suspense
            fallback={
              <EntityGrid.Skeleton
                count={8}
                columns={{ sm: 2, md: 3, lg: 4 }}
              />
            }
          >
            <OrganizationsGrid query={deferredQuery} />
          </Suspense>
        </div>
      </div>

      <CreateOrganizationDialog
        open={isCreateDialogOpen}
        onOpenChange={setIsCreateDialogOpen}
      />
    </div>
  );
}
