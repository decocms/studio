import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@deco/ui/components/alert-dialog.tsx";
import { Badge } from "@deco/ui/components/badge.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { Button } from "@deco/ui/components/button.tsx";
import { Checkbox } from "@deco/ui/components/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@deco/ui/components/table.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import {
  CheckCircle,
  Eye,
  LinkExternal01,
  Trash01,
  XCircle,
} from "@untitledui/icons";
import { toast } from "sonner";
import {
  usePublishRequestMutations,
  usePublishRequests,
  useRegistryMutations,
} from "@/web/hooks/registry/use-registry";
import type {
  PublishRequest,
  PublishRequestStatus,
} from "@/web/lib/registry/types";
import { useInfiniteScroll } from "@/web/hooks/use-infinite-scroll";

const STATUS_OPTIONS: Array<{ value: PublishRequestStatus; label: string }> = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
];

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString();
}

function requestToDraft(request: PublishRequest) {
  return {
    id: request.requested_id ?? request.server?.name,
    title: request.title,
    description: request.description ?? "",
    _meta: request._meta,
    server: request.server,
    is_public: false,
  };
}

function getIconUrl(request: PublishRequest): string | null {
  const icon = request.server?.icons?.[0]?.src;
  return typeof icon === "string" && icon.length > 0 ? icon : null;
}

function getReadmeMeta(request: PublishRequest): {
  hasReadmeContent: boolean;
  hasReadmeLink: boolean;
  readmeContent: string;
  readmeUrl: string;
} {
  const meshMeta = request._meta?.["mcp.mesh"];
  return {
    hasReadmeContent: Boolean(meshMeta?.readme?.trim()),
    hasReadmeLink: Boolean(meshMeta?.readme_url?.trim()),
    readmeContent: meshMeta?.readme?.trim() ?? "",
    readmeUrl: meshMeta?.readme_url?.trim() ?? "",
  };
}

export default function RegistryRequestsPage() {
  const [status, setStatus] = useState<PublishRequestStatus>("pending");
  const [sortBy, setSortBy] = useState<"created_at" | "title">("created_at");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkApproveOpen, setBulkApproveOpen] = useState(false);
  const [bulkVisibility, setBulkVisibility] = useState<"private" | "public">(
    "private",
  );
  const [isBulkApproving, setIsBulkApproving] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [confirmApproveRequest, setConfirmApproveRequest] =
    useState<PublishRequest | null>(null);
  const [rejectingRequest, setRejectingRequest] =
    useState<PublishRequest | null>(null);
  const [viewingRequest, setViewingRequest] = useState<PublishRequest | null>(
    null,
  );
  const [rejectNotes, setRejectNotes] = useState("");

  const listQuery = usePublishRequests({ status, sortBy, sortDirection });
  const { reviewMutation, deleteMutation } = usePublishRequestMutations();
  const { createMutation } = useRegistryMutations();

  const requests = listQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const totalCount = listQuery.data?.pages[0]?.totalCount ?? 0;
  const isFetchingMore = listQuery.isFetchingNextPage;
  const hasMore = Boolean(listQuery.hasNextPage);
  const loadMoreRef = useInfiniteScroll(
    () => {
      if (!listQuery.isFetchingNextPage) {
        void listQuery.fetchNextPage();
      }
    },
    hasMore,
    isFetchingMore,
  );

  const pendingById = new Set(
    requests
      .filter((request) => request.status === "pending")
      .map((request) => request.id),
  );
  const pendingRequests = requests.filter((request) =>
    pendingById.has(request.id),
  );
  const selectedCount = selectedIds.size;
  const selectedRequests = pendingRequests.filter((request) =>
    selectedIds.has(request.id),
  );
  const selectedVisibleCount = requests.filter((request) =>
    selectedIds.has(request.id),
  ).length;
  const allVisiblePendingSelected =
    pendingRequests.length > 0 &&
    pendingRequests.every((request) => selectedIds.has(request.id));

  const clearSelection = () => setSelectedIds(new Set());
  const toggleSelected = (id: string, checked: boolean) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };
  const toggleRequestSelection = (id: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };
  const selectVisiblePending = () => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      for (const request of pendingRequests) {
        next.add(request.id);
      }
      return next;
    });
  };

  const handleApproveConfirmed = async () => {
    const request = confirmApproveRequest;
    if (!request) return;
    setConfirmApproveRequest(null);
    setApprovingId(request.id);
    try {
      // 1. Review first — has conflict check (findByIdOrName)
      await reviewMutation.mutateAsync({
        id: request.id,
        status: "approved",
        reviewerNotes: undefined,
      });
      // 2. Then create the registry item
      const draft = requestToDraft(request);
      await createMutation.mutateAsync({
        id: draft.id,
        title: draft.title,
        description: draft.description,
        _meta: draft._meta,
        server: draft.server,
        is_public: draft.is_public,
      });
      toast.success("Request approved and added to registry");
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : "Failed to approve request";
      if (msg.includes("UNIQUE constraint") || msg.includes("already exists")) {
        toast.error(
          "An item with this ID already exists in the registry. Delete or rename it first.",
        );
      } else {
        toast.error(msg);
      }
    } finally {
      setApprovingId(null);
    }
  };

  const handleReject = async () => {
    if (!rejectingRequest) return;
    try {
      await reviewMutation.mutateAsync({
        id: rejectingRequest.id,
        status: "rejected",
        reviewerNotes: rejectNotes.trim() || undefined,
      });
      toast.success("Request rejected");
      setRejectingRequest(null);
      setRejectNotes("");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to reject request",
      );
    }
  };

  const handleDelete = async (request: PublishRequest) => {
    try {
      await deleteMutation.mutateAsync(request.id);
      toast.success("Request deleted");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to delete request",
      );
    }
  };

  const handleBulkApproveConfirmed = async () => {
    if (selectedRequests.length === 0 || isBulkApproving) return;
    setIsBulkApproving(true);
    setBulkApproveOpen(false);

    let approvedCount = 0;
    const failedIds = new Set<string>();

    for (const request of selectedRequests) {
      try {
        await reviewMutation.mutateAsync({
          id: request.id,
          status: "approved",
          reviewerNotes: undefined,
        });

        const draft = requestToDraft(request);
        await createMutation.mutateAsync({
          id: draft.id,
          title: draft.title,
          description: draft.description,
          _meta: draft._meta,
          server: draft.server,
          is_public: bulkVisibility === "public",
        });

        approvedCount++;
      } catch {
        failedIds.add(request.id);
      }
    }

    const failedCount = failedIds.size;
    if (approvedCount > 0 && failedCount === 0) {
      toast.success(
        `${approvedCount} request${approvedCount > 1 ? "s" : ""} approved as ${bulkVisibility}.`,
      );
    } else if (approvedCount > 0 && failedCount > 0) {
      toast.warning(
        `Approved ${approvedCount}. Failed ${failedCount}. Failed items remain selected for retry.`,
      );
    } else {
      toast.error("Bulk approve failed. Selected items were kept for retry.");
    }

    setSelectedIds(failedIds);
    setIsBulkApproving(false);
  };

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 border-b border-border">
        <div className="h-12 px-4 md:px-6 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-sm font-medium">Requests to Publish</h2>
            <Badge variant="secondary" className="text-xs">
              {totalCount}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-lg border border-border p-0.5">
              {STATUS_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={cn(
                    "px-2.5 py-1 text-xs rounded-md transition-colors",
                    status === option.value
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => setStatus(option.value)}
                  onClickCapture={() => clearSelection()}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <select
              className="h-7 rounded-md border border-input bg-background px-2 text-xs"
              value={`${sortBy}:${sortDirection}`}
              onChange={(event) => {
                const [nextSortBy, nextDirection] =
                  event.target.value.split(":");
                setSortBy(nextSortBy as "created_at" | "title");
                setSortDirection(nextDirection as "asc" | "desc");
              }}
            >
              <option value="created_at:asc">Created at (oldest first)</option>
              <option value="created_at:desc">Created at (newest first)</option>
              <option value="title:asc">Alphabetical (A-Z)</option>
              <option value="title:desc">Alphabetical (Z-A)</option>
            </select>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-4 md:px-6 py-4">
        {listQuery.isLoading ? (
          <div className="text-sm text-muted-foreground">
            Loading requests...
          </div>
        ) : listQuery.isError ? (
          <div className="p-8 text-center rounded-lg border border-border">
            <p className="text-sm text-destructive">
              Failed to load publish requests.
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {listQuery.error instanceof Error
                ? listQuery.error.message
                : "Unknown error"}
            </p>
          </div>
        ) : requests.length === 0 ? (
          <div className="p-8 text-center rounded-lg border border-border">
            <p className="text-sm text-muted-foreground">
              {status === "pending"
                ? "No pending publish requests."
                : status === "approved"
                  ? "No approved publish requests."
                  : "No rejected publish requests."}
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                {status === "pending" && (
                  <TableHead className="w-10">
                    <Checkbox
                      checked={
                        allVisiblePendingSelected && pendingRequests.length > 0
                      }
                      onCheckedChange={(checked) => {
                        if (checked) {
                          selectVisiblePending();
                        } else {
                          clearSelection();
                        }
                      }}
                    />
                  </TableHead>
                )}
                <TableHead>Name</TableHead>
                <TableHead>Requester</TableHead>
                <TableHead>Tags</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {requests.map((request) => {
                const iconUrl = getIconUrl(request);
                const tags = request._meta?.["mcp.mesh"]?.tags ?? [];
                const isPending = pendingById.has(request.id);
                const isSelected = selectedIds.has(request.id);

                return (
                  <TableRow
                    key={request.id}
                    className={cn(
                      isPending && "cursor-pointer",
                      isSelected && "bg-accent/20",
                    )}
                    onClick={() => {
                      if (isPending) toggleRequestSelection(request.id);
                    }}
                  >
                    {status === "pending" && (
                      <TableCell>
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={(checked) =>
                            toggleSelected(request.id, checked === true)
                          }
                          onClick={(event) => event.stopPropagation()}
                        />
                      </TableCell>
                    )}
                    <TableCell>
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="size-7 rounded-md border border-border bg-muted/30 overflow-hidden shrink-0 flex items-center justify-center">
                          {iconUrl ? (
                            <img
                              src={iconUrl}
                              alt={request.title}
                              className="h-full w-full object-cover"
                              loading="lazy"
                            />
                          ) : (
                            <span className="text-[10px] font-semibold text-muted-foreground">
                              {request.title.slice(0, 1).toUpperCase()}
                            </span>
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">
                            {request.title}
                          </p>
                          {request.description && (
                            <p className="text-xs text-muted-foreground truncate max-w-[300px]">
                              {request.description}
                            </p>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-muted-foreground truncate">
                        {request.requester_name ||
                          request.requester_email ||
                          "-"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {tags.slice(0, 3).map((tag) => (
                          <Badge
                            key={`${request.id}-tag-${tag}`}
                            variant="secondary"
                            className="text-[10px]"
                          >
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="secondary"
                        className="capitalize text-[11px]"
                      >
                        {request.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-muted-foreground">
                        {formatDate(request.created_at)}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs px-2"
                          onClick={(event) => {
                            event.stopPropagation();
                            setViewingRequest(request);
                          }}
                        >
                          <Eye size={13} />
                          View
                        </Button>
                        {isPending ? (
                          <>
                            <Button
                              size="sm"
                              className="h-7 text-xs px-2"
                              onClick={(event) => {
                                event.stopPropagation();
                                setConfirmApproveRequest(request);
                              }}
                              disabled={
                                approvingId !== null ||
                                isBulkApproving ||
                                isSelected
                              }
                            >
                              <CheckCircle size={13} />
                              {approvingId === request.id
                                ? "Approving..."
                                : isSelected
                                  ? "Selected"
                                  : "Approve"}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs px-2"
                              onClick={(event) => {
                                event.stopPropagation();
                                setRejectingRequest(request);
                                setRejectNotes("");
                              }}
                              disabled={reviewMutation.isPending}
                            >
                              <XCircle size={13} />
                              Reject
                            </Button>
                          </>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs px-2"
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleDelete(request);
                            }}
                            disabled={deleteMutation.isPending}
                          >
                            <Trash01 size={13} />
                            Delete
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {requests.length > 0 && hasMore ? (
          <div ref={loadMoreRef} className="h-1 w-full" />
        ) : null}
        {isFetchingMore && requests.length > 0 ? (
          <div className="pt-3 text-xs text-muted-foreground">
            Loading more requests...
          </div>
        ) : null}
      </div>

      {selectedCount > 0 ? (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2">
          <div className="rounded-xl border border-border bg-background/95 shadow-lg backdrop-blur px-3 py-2 flex items-center gap-2">
            <div className="text-xs text-muted-foreground pr-1">
              {selectedCount} selected
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs px-2"
              onClick={selectVisiblePending}
              disabled={allVisiblePendingSelected}
            >
              Select all
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs px-2"
              onClick={clearSelection}
            >
              Clear selection
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs px-2"
              onClick={() => setBulkApproveOpen(true)}
              disabled={isBulkApproving}
            >
              <CheckCircle size={13} />
              Approve selected
            </Button>
          </div>
        </div>
      ) : null}

      <Dialog
        open={Boolean(viewingRequest)}
        onOpenChange={(next) => {
          if (!next) {
            setViewingRequest(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-[720px] max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>
              {viewingRequest?.title ?? "Request details"}
            </DialogTitle>
            <DialogDescription>
              Review all metadata sent by the requester before approving.
            </DialogDescription>
          </DialogHeader>
          {viewingRequest && (
            <div className="flex-1 overflow-y-auto pr-1 space-y-4">
              <div className="rounded-lg border border-border bg-muted/20 p-3 flex items-center gap-3">
                <div className="size-16 rounded-lg border border-border bg-muted/30 overflow-hidden shrink-0 flex items-center justify-center">
                  {getIconUrl(viewingRequest) ? (
                    <img
                      src={getIconUrl(viewingRequest) || ""}
                      alt={viewingRequest.title}
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <span className="text-lg font-semibold text-muted-foreground">
                      {viewingRequest.title.slice(0, 1).toUpperCase()}
                    </span>
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">
                    {viewingRequest.title}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {viewingRequest.server?.name || viewingRequest.id}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="grid gap-1">
                  <span className="text-xs text-muted-foreground">Status</span>
                  <span className="capitalize">{viewingRequest.status}</span>
                </div>
                <div className="grid gap-1">
                  <span className="text-xs text-muted-foreground">
                    Submitted
                  </span>
                  <span>{formatDate(viewingRequest.created_at)}</span>
                </div>
                <div className="grid gap-1">
                  <span className="text-xs text-muted-foreground">
                    Requester
                  </span>
                  <span>{viewingRequest.requester_name || "-"}</span>
                </div>
                <div className="grid gap-1">
                  <span className="text-xs text-muted-foreground">Email</span>
                  <span>{viewingRequest.requester_email || "-"}</span>
                </div>
              </div>

              <div className="grid gap-1.5">
                <Label>Remote URL</Label>
                <code className="text-xs rounded-md border border-border bg-muted/30 px-2.5 py-2 break-all">
                  {viewingRequest.server?.remotes?.[0]?.url ?? "-"}
                </code>
              </div>

              <div className="grid gap-1.5">
                <Label>Description</Label>
                <p className="text-sm text-muted-foreground">
                  {viewingRequest.description || "No description provided."}
                </p>
              </div>

              <div className="grid gap-1.5">
                <Label>Tags</Label>
                <div className="flex flex-wrap gap-1.5">
                  {(viewingRequest._meta?.["mcp.mesh"]?.tags ?? []).length ? (
                    (viewingRequest._meta?.["mcp.mesh"]?.tags ?? []).map(
                      (tag) => (
                        <Badge
                          key={`${viewingRequest.id}-detail-tag-${tag}`}
                          variant="secondary"
                        >
                          {tag}
                        </Badge>
                      ),
                    )
                  ) : (
                    <span className="text-sm text-muted-foreground">-</span>
                  )}
                </div>
              </div>

              <div className="grid gap-1.5">
                <Label>Categories</Label>
                <div className="flex flex-wrap gap-1.5">
                  {(viewingRequest._meta?.["mcp.mesh"]?.categories ?? [])
                    .length ? (
                    (viewingRequest._meta?.["mcp.mesh"]?.categories ?? []).map(
                      (category) => (
                        <Badge
                          key={`${viewingRequest.id}-detail-category-${category}`}
                          variant="secondary"
                        >
                          {category}
                        </Badge>
                      ),
                    )
                  ) : (
                    <span className="text-sm text-muted-foreground">-</span>
                  )}
                </div>
              </div>

              <div className="grid gap-1.5">
                <Label>README</Label>
                {getReadmeMeta(viewingRequest).hasReadmeContent ? (
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap max-h-40 overflow-y-auto rounded-md border border-border bg-muted/20 px-2.5 py-2">
                    {getReadmeMeta(viewingRequest).readmeContent}
                  </p>
                ) : getReadmeMeta(viewingRequest).hasReadmeLink ? (
                  <a
                    href={getReadmeMeta(viewingRequest).readmeUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm inline-flex items-center gap-1.5 text-primary hover:underline"
                  >
                    Open README link
                    <LinkExternal01 size={14} />
                  </a>
                ) : (
                  <span className="text-sm text-muted-foreground">
                    No README provided.
                  </span>
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewingRequest(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Approve confirmation */}
      <AlertDialog
        open={Boolean(confirmApproveRequest)}
        onOpenChange={(next) => {
          if (!next) setConfirmApproveRequest(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve publish request?</AlertDialogTitle>
            <AlertDialogDescription>
              This will add{" "}
              <span className="font-medium text-foreground">
                {confirmApproveRequest?.title}
              </span>{" "}
              to your private registry. The requester will be notified of the
              approval.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleApproveConfirmed}>
              Approve
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={bulkApproveOpen} onOpenChange={setBulkApproveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve selected requests?</AlertDialogTitle>
            <AlertDialogDescription>
              This will approve {selectedRequests.length} request
              {selectedRequests.length > 1 ? "s" : ""} and create all resulting
              apps with the same visibility setting.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="bulk-visibility">Visibility for all selected</Label>
            <select
              id="bulk-visibility"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={bulkVisibility}
              onChange={(event) =>
                setBulkVisibility(event.target.value as "private" | "public")
              }
            >
              <option value="private">Private</option>
              <option value="public">Public</option>
            </select>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isBulkApproving}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBulkApproveConfirmed}
              disabled={isBulkApproving || selectedVisibleCount === 0}
            >
              {isBulkApproving ? "Approving..." : "Approve selected"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={Boolean(rejectingRequest)}
        onOpenChange={(next) => {
          if (!next) {
            setRejectingRequest(null);
            setRejectNotes("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject publish request?</DialogTitle>
            <DialogDescription>
              This request will move to rejected status. You can leave optional
              notes for context.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="reject-notes">Reviewer notes (optional)</Label>
            <Textarea
              id="reject-notes"
              rows={4}
              value={rejectNotes}
              onChange={(event) => setRejectNotes(event.target.value)}
              placeholder="Reason for rejection..."
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setRejectingRequest(null);
                setRejectNotes("");
              }}
            >
              Cancel
            </Button>
            <Button onClick={handleReject} disabled={reviewMutation.isPending}>
              {reviewMutation.isPending ? "Rejecting..." : "Reject"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
