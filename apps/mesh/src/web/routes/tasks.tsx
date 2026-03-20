import { TaskListContent } from "@/web/components/chat/tasks-panel";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { Page } from "@/web/components/page";
import { useProjectContext } from "@decocms/mesh-sdk";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@deco/ui/components/breadcrumb.tsx";
import { Loading01 } from "@untitledui/icons";
import { useNavigate } from "@tanstack/react-router";
import { Suspense } from "react";
import { useChatStable } from "../components/chat/context";

function TasksContent() {
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const { switchToTask } = useChatStable();

  const handleTaskSelect = async (taskId: string) => {
    await switchToTask(taskId);
    navigate({
      to: "/$org",
      params: { org: org.slug },
    });
  };

  return (
    <Page>
      <Page.Header>
        <Page.Header.Left>
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>Tasks</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </Page.Header.Left>
      </Page.Header>
      <Page.Content>
        <div className="h-full flex flex-col overflow-hidden">
          <TaskListContent onTaskSelect={handleTaskSelect} />
        </div>
      </Page.Content>
    </Page>
  );
}

export default function TasksPage() {
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
        <TasksContent />
      </Suspense>
    </ErrorBoundary>
  );
}
