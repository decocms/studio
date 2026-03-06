/**
 * ThreadShareDialog
 *
 * Dialog to share a thread with org members.
 * Shows current members and allows adding/removing them.
 * The thread owner and any current member can manage membership.
 */

import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@deco/ui/components/dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Share07, X, UserPlus01 } from "@untitledui/icons";
import { Suspense, useState } from "react";
import { authClient } from "@/web/lib/auth-client";
import { KEYS } from "@/web/lib/query-keys";
import { toast } from "sonner";

interface ToolCallError {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
}

interface ThreadMember {
  user_id: string;
  added_by: string;
  added_at: string;
}

interface OrgMember {
  id: string;
  userId: string;
  role: string;
  user?: {
    id: string;
    name: string;
    email: string;
    image?: string;
  };
}

interface ThreadShareDialogInnerProps {
  threadId: string;
  threadOwnerId: string;
}

function ThreadShareDialogInner({
  threadId,
  threadOwnerId,
}: ThreadShareDialogInnerProps) {
  const { org, locator } = useProjectContext();
  const queryClient = useQueryClient();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  const [search, setSearch] = useState("");

  // Fetch current thread members
  const { data: membersData, isLoading: membersLoading } = useQuery({
    queryKey: KEYS.threadMembers(threadId),
    queryFn: async () => {
      if (!client) return { members: [] as ThreadMember[] };
      const result = (await client.callTool({
        name: "THREAD_MEMBERS_LIST",
        arguments: { thread_id: threadId },
      })) as ToolCallError & {
        structuredContent?: { members: ThreadMember[] };
        members?: ThreadMember[];
      };
      if (result.isError) {
        const message =
          result.content?.find((c) => c.type === "text")?.text ??
          "Failed to list members";
        throw new Error(message);
      }
      const payload = result.structuredContent ?? result;
      return {
        members: (payload as { members: ThreadMember[] }).members ?? [],
      };
    },
    enabled: !!client,
  });

  // Fetch org members
  const { data: orgMembersData } = useQuery({
    queryKey: KEYS.members(locator),
    queryFn: () => authClient.organization.listMembers(),
  });

  const currentMembers: ThreadMember[] = membersData?.members ?? [];
  const orgMembers: OrgMember[] = (orgMembersData?.data?.members ??
    []) as OrgMember[];

  // Members already added to thread (by userId)
  const addedUserIds = new Set(currentMembers.map((m) => m.user_id));

  // Org members not yet added (excluding the owner)
  const available = orgMembers.filter(
    (m) => m.userId !== threadOwnerId && !addedUserIds.has(m.userId),
  );

  const filtered = search.trim()
    ? available.filter((m) => {
        const name = m.user?.name?.toLowerCase() ?? "";
        const email = m.user?.email?.toLowerCase() ?? "";
        const q = search.toLowerCase();
        return name.includes(q) || email.includes(q);
      })
    : available;

  const addMember = useMutation({
    mutationFn: async (userId: string) => {
      if (!client) throw new Error("MCP client not available");
      const result = (await client.callTool({
        name: "THREAD_MEMBER_ADD",
        arguments: { thread_id: threadId, user_id: userId },
      })) as ToolCallError;
      if (result.isError) {
        const message =
          result.content?.find((c) => c.type === "text")?.text ??
          "Failed to add member";
        throw new Error(message);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.threadMembers(threadId) });
    },
    onError: (err: Error) => {
      toast.error(err.message ?? "Failed to add member");
    },
  });

  const removeMember = useMutation({
    mutationFn: async (userId: string) => {
      if (!client) throw new Error("MCP client not available");
      const result = (await client.callTool({
        name: "THREAD_MEMBER_REMOVE",
        arguments: { thread_id: threadId, user_id: userId },
      })) as ToolCallError;
      if (result.isError) {
        const message =
          result.content?.find((c) => c.type === "text")?.text ??
          "Failed to remove member";
        throw new Error(message);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.threadMembers(threadId) });
    },
    onError: (err: Error) => {
      toast.error(err.message ?? "Failed to remove member");
    },
  });

  const getOrgMember = (userId: string) =>
    orgMembers.find((m) => m.userId === userId);

  return (
    <div className="flex flex-col gap-4">
      {/* Current members */}
      {currentMembers.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Shared with
          </p>
          <div className="flex flex-col gap-1">
            {currentMembers.map((member) => {
              const orgMember = getOrgMember(member.user_id);
              return (
                <div
                  key={member.user_id}
                  className="flex items-center gap-2 py-1"
                >
                  <Avatar
                    url={orgMember?.user?.image ?? undefined}
                    fallback={orgMember?.user?.name?.charAt(0) ?? "?"}
                    shape="circle"
                    size="sm"
                  />
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="text-sm font-medium text-foreground truncate">
                      {orgMember?.user?.name ?? member.user_id}
                    </span>
                    {orgMember?.user?.email && (
                      <span className="text-xs text-muted-foreground truncate">
                        {orgMember.user.email}
                      </span>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 shrink-0"
                    disabled={removeMember.isPending}
                    onClick={() => removeMember.mutate(member.user_id)}
                    title="Remove"
                  >
                    <X size={12} />
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Search + add members */}
      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Add member
        </p>
        <input
          type="text"
          placeholder="Search by name or email..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full text-sm px-3 py-2 border border-border rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-ring"
        />
        {filtered.length === 0 && !membersLoading && (
          <p className="text-xs text-muted-foreground py-2 text-center">
            {search
              ? "No members found"
              : "All org members already have access"}
          </p>
        )}
        <div className="flex flex-col gap-1 max-h-48 overflow-y-auto">
          {filtered.map((member) => (
            <div key={member.userId} className="flex items-center gap-2 py-1">
              <Avatar
                url={member.user?.image ?? undefined}
                fallback={member.user?.name?.charAt(0) ?? "?"}
                shape="circle"
                size="sm"
              />
              <div className="flex flex-col min-w-0 flex-1">
                <span className="text-sm font-medium text-foreground truncate">
                  {member.user?.name ?? member.userId}
                </span>
                {member.user?.email && (
                  <span className="text-xs text-muted-foreground truncate">
                    {member.user.email}
                  </span>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 shrink-0"
                disabled={addMember.isPending}
                onClick={() => addMember.mutate(member.userId)}
                title="Add"
              >
                <UserPlus01 size={12} />
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

interface ThreadShareDialogProps {
  threadId: string;
  threadOwnerId: string;
  trigger?: React.ReactNode;
}

export function ThreadShareDialog({
  threadId,
  threadOwnerId,
  trigger,
}: ThreadShareDialogProps) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        {trigger ?? (
          <button
            type="button"
            className="flex size-6 items-center justify-center rounded-full p-1 hover:bg-transparent group cursor-pointer"
            title="Share thread"
          >
            <Share07
              size={16}
              className="text-muted-foreground group-hover:text-foreground transition-colors"
            />
          </button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Share thread</DialogTitle>
        </DialogHeader>
        <Suspense
          fallback={
            <div className="py-8 text-center text-sm text-muted-foreground">
              Loading...
            </div>
          }
        >
          <ThreadShareDialogInner
            threadId={threadId}
            threadOwnerId={threadOwnerId}
          />
        </Suspense>
      </DialogContent>
    </Dialog>
  );
}
