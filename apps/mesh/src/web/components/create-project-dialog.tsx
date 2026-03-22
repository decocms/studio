import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { KEYS } from "@/web/lib/query-keys";
import { useState } from "react";

interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type VirtualMCPCreateOutput = {
  item: {
    id: string;
    title: string;
  };
};

export function CreateProjectDialog({
  open,
  onOpenChange,
}: CreateProjectDialogProps) {
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");

  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  const mutation = useMutation({
    mutationFn: async (title: string) => {
      const result = (await client.callTool({
        name: "COLLECTION_VIRTUAL_MCP_CREATE",
        arguments: {
          data: {
            title,
            description: null,
            subtype: "project",
            metadata: {
              instructions: null,
              enabled_plugins: [],
              ui: {
                banner: null,
                bannerColor: null,
                icon: null,
                themeColor: null,
              },
            },
            connections: [],
          },
        },
      })) as { structuredContent?: unknown };
      const payload = (result.structuredContent ??
        result) as VirtualMCPCreateOutput;
      return payload.item;
    },
    onSuccess: (item) => {
      queryClient.invalidateQueries({ queryKey: KEYS.projects(org.id) });
      toast.success("Project created");
      onOpenChange(false);
      setName("");
      navigate({
        to: "/$org/projects/$virtualMcpId",
        params: { org: org.slug, virtualMcpId: item.id },
      });
    },
    onError: (error) => {
      toast.error(
        "Failed to create project: " +
          (error instanceof Error ? error.message : "Unknown error"),
      );
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    mutation.mutate(name.trim());
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Create New Project</DialogTitle>
          <DialogDescription>
            Give your project a name. You can configure everything else after
            creation.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Project name"
            autoFocus
            disabled={mutation.isPending}
          />

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending || !name.trim()}>
              {mutation.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
