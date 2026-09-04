import { PromptDetailsView } from "@/components/details/prompt/index.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { ToolDetailsView } from "@/components/details/tool.tsx";
import { ErrorBoundary } from "@/components/error-boundary";
import { Main } from "@/components/main";
import { MainBreadcrumb } from "@/components/main-breadcrumb";
import { connectionMainBreadcrumbItem } from "@/components/main-breadcrumb/route-items";
import {
  useCollectionActions,
  useConnections,
  useMCPClient,
  useProjectContext,
  type ConnectionEntity,
} from "@/sdk";

import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { Container } from "@untitledui/icons";
import { useParams, useRouter } from "@tanstack/react-router";
import { Suspense, type ComponentType } from "react";
import { useT } from "@/i18n/use-t.ts";

interface CollectionDetailsProps {
  appSlug: string;
  connection: ConnectionEntity | null;
  itemId: string;
  onBack: () => void;
  onUpdate: (updates: Record<string, unknown>) => Promise<void>;
}

// Map of well-known views by collection name
const WELL_KNOWN_VIEW_DETAILS: Record<
  string,
  ComponentType<CollectionDetailsProps>
> = {
  prompt: PromptDetailsView,
};

function ToolDetailsContent() {
  const router = useRouter();
  const params = useParams({
    from: "/shell/$org/settings/connections/$appSlug/$collectionName/$itemId",
  });

  const itemId = params.itemId;

  const siblings = useConnections({ slug: params.appSlug });

  const handleBack = () => {
    router.history.back();
  };

  const handleUpdate = async (_updates: Record<string, unknown>) => {
    // Tools don't use collections, so updates are handled by ToolDetailsView
    // This is a no-op for tools since they don't have collection-based updates
    return Promise.resolve();
  };

  return (
    <ToolDetailsView
      itemId={itemId}
      siblings={siblings}
      onBack={handleBack}
      onUpdate={handleUpdate}
    />
  );
}

function CollectionDetailsContent() {
  const router = useRouter();
  const params = useParams({
    from: "/shell/$org/settings/connections/$appSlug/$collectionName/$itemId",
  });

  const t = useT();
  const collectionName = params.collectionName;
  const itemId = params.itemId;

  const handleBack = () => {
    router.history.back();
  };

  const { org } = useProjectContext();
  const slugConnections = useConnections({ slug: params.appSlug });
  const connection = slugConnections[0] ?? null;
  const connectionId = connection?.id ?? "";
  const scopeKey = connectionId || "no-connection";
  const client = useMCPClient({
    connectionId: connectionId ?? null,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const actions = useCollectionActions(scopeKey, collectionName, client);

  const handleUpdate = async (updates: Record<string, unknown>) => {
    if (!itemId) return;
    await actions.update.mutateAsync({
      id: itemId,
      data: updates,
    });
    // Success/error toasts are handled by the mutation's onSuccess/onError
  };

  // Check for well-known collections (case insensitive, singular/plural)
  const normalizedCollectionName = collectionName?.toLowerCase();

  const ViewComponent =
    normalizedCollectionName &&
    WELL_KNOWN_VIEW_DETAILS[normalizedCollectionName];

  const connectionParent = connection ? (
    <MainBreadcrumb.Parent.Portal
      item={connectionMainBreadcrumbItem(
        org.slug,
        params.appSlug,
        connection,
        collectionName,
      )}
    />
  ) : null;

  if (ViewComponent) {
    return (
      <>
        {connectionParent}
        <ViewComponent
          appSlug={params.appSlug}
          connection={connection}
          itemId={itemId}
          onBack={handleBack}
          onUpdate={handleUpdate}
        />
      </>
    );
  }

  return (
    <>
      {connectionParent}
      <Main.Title.Portal>
        <span title={itemId}>{itemId}</span>
      </Main.Title.Portal>
      <div className="flex h-full min-h-0 items-center justify-center">
        <EmptyState
          icon={<Container size={36} className="text-muted-foreground" />}
          title={t("orgs.collectionDetail.noComponentDefinedTitle")}
          description={t("orgs.collectionDetail.noComponentDefinedDescription")}
          buttonProps={{
            onClick: handleBack,
            children: t("orgs.collectionDetail.goBackButton"),
          }}
        />
      </div>
    </>
  );
}

function CollectionDetailsRouter() {
  const params = useParams({
    from: "/shell/$org/settings/connections/$appSlug/$collectionName/$itemId",
  });

  const collectionName = params.collectionName;

  const isTools = collectionName === "tools";

  if (isTools) {
    return <ToolDetailsContent />;
  }

  return <CollectionDetailsContent />;
}

export default function CollectionDetails() {
  return (
    <ErrorBoundary>
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center">
            <Spinner className="size-8 text-muted-foreground" />
          </div>
        }
      >
        <CollectionDetailsRouter />
      </Suspense>
    </ErrorBoundary>
  );
}
