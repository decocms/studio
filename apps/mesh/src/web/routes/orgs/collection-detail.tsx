import { PromptDetailsView } from "@/web/components/details/prompt/index.tsx";
import { ToolDetailsView } from "@/web/components/details/tool.tsx";
import { ErrorBoundary } from "@/web/components/error-boundary";
import {
  ORG_ADMIN_PROJECT_SLUG,
  useCollectionActions,
  useConnections,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { getConnectionSlug } from "@/web/utils/connection-slug";
import { EmptyState } from "@deco/ui/components/empty-state.tsx";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@deco/ui/components/breadcrumb.tsx";
import { Loading01, Container } from "@untitledui/icons";
import { Link, useParams, useRouter } from "@tanstack/react-router";
import { Suspense, type ComponentType } from "react";
import {
  WorkflowExecutionDetailsView,
  WorkflowDetails,
} from "@/web/components/details/workflow/index.tsx";
import { ViewLayout } from "@/web/components/details/layout";

interface CollectionDetailsProps {
  itemId: string;
  onBack: () => void;
  onUpdate: (updates: Record<string, unknown>) => Promise<void>;
}

// Map of well-known views by collection name
const WELL_KNOWN_VIEW_DETAILS: Record<
  string,
  ComponentType<CollectionDetailsProps>
> = {
  workflow: WorkflowDetails,
  workflow_execution: WorkflowExecutionDetailsView,
  prompt: PromptDetailsView,
};

function ToolDetailsContent() {
  const router = useRouter();
  const params = useParams({
    from: "/shell/$org/$project/mcps/$appSlug/$collectionName/$itemId",
  });

  const itemId = decodeURIComponent(params.itemId);

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
      onBack={handleBack}
      onUpdate={handleUpdate}
    />
  );
}

/**
 * Formats a collection name for display
 * e.g., "LLM" -> "Llm", "USER_PROFILES" -> "User Profiles"
 */
function formatCollectionName(name: string): string {
  return name
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function CollectionDetailsContent() {
  const router = useRouter();
  const params = useParams({
    from: "/shell/$org/$project/mcps/$appSlug/$collectionName/$itemId",
  });

  const collectionName = decodeURIComponent(params.collectionName);
  const itemId = decodeURIComponent(params.itemId);

  const handleBack = () => {
    router.history.back();
  };

  const { org } = useProjectContext();
  const allConnections = useConnections();
  const connection =
    allConnections.find(
      (c) =>
        c.connection_type !== "VIRTUAL" &&
        getConnectionSlug(c) === params.appSlug,
    ) ?? null;
  const connectionId = connection?.id ?? "";
  const scopeKey = connectionId || "no-connection";
  const client = useMCPClient({
    connectionId: connectionId ?? null,
    orgId: org.id,
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

  const collectionDisplayName = formatCollectionName(collectionName);

  const breadcrumb = (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link
              to="/$org/$project/mcps"
              params={{ org: org.slug, project: ORG_ADMIN_PROJECT_SLUG }}
            >
              Connections
            </Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        {connection && (
          <>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link
                  to="/$org/$project/mcps/$appSlug"
                  params={{
                    org: org.slug,
                    project: ORG_ADMIN_PROJECT_SLUG,
                    appSlug: params.appSlug,
                  }}
                  search={{ tab: collectionName }}
                >
                  {connection.title}
                </Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
          </>
        )}
        <BreadcrumbItem>
          <BreadcrumbPage>{collectionDisplayName}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );

  if (ViewComponent) {
    return (
      <ViewComponent
        itemId={itemId}
        onBack={handleBack}
        onUpdate={handleUpdate}
      />
    );
  }

  return (
    <ViewLayout breadcrumb={breadcrumb}>
      <EmptyState
        icon={<Container size={36} className="text-muted-foreground" />}
        title="No component defined"
        description="No component for this collection was defined"
        buttonProps={{
          onClick: handleBack,
          children: "Go back",
        }}
      />
    </ViewLayout>
  );
}

function CollectionDetailsRouter() {
  const params = useParams({
    from: "/shell/$org/$project/mcps/$appSlug/$collectionName/$itemId",
  });

  const collectionName = decodeURIComponent(params.collectionName);

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
            <Loading01
              size={32}
              className="animate-spin text-muted-foreground"
            />
          </div>
        }
      >
        <CollectionDetailsRouter />
      </Suspense>
    </ErrorBoundary>
  );
}
