/**
 * Unified slash (/) mention component that combines prompts, resources, and
 * skills into a single dropdown, in that order. Prompts/resources come from the
 * connected MCP; skills come from the org's skill catalog (home + public sets,
 * incl. storefront) and inline their SKILL.md when selected.
 */

import {
  getGatewayClientId,
  stripToolNamespace,
} from "@decocms/mcp-utils/aggregate";
import { KEYS } from "@/lib/query-keys";
import {
  getPrompt,
  listPrompts,
  listResources,
  readResource,
  useMCPClient,
  useProjectContext,
} from "@/sdk";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  ListPromptsResult,
  ListResourcesResult,
  Prompt,
} from "@modelcontextprotocol/sdk/types.js";
import {
  fetchOrgFsSkillCatalog,
  fetchOrgFsSkillFiles,
  type OrgFsSkillCatalogEntry,
  type OrgFsSkillFile,
} from "@/hooks/use-org-fs";
import { useQueryClient } from "@tanstack/react-query";
import type { Editor, Range } from "@tiptap/react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { useT } from "@/i18n/use-t.ts";
import {
  PromptArgsDialog,
  type PromptArgumentValues,
} from "../dialog-prompt-arguments.tsx";
import {
  BaseItem,
  createMentionDoc,
  getMentionStorage,
  insertMention,
  isMentionNodeAt,
  OnSelectProps,
  Suggestion,
  type EditMentionRequest,
} from "./mention";
import { track } from "@/lib/posthog-client";

interface SlashMentionProps {
  editor: Editor;
  virtualMcpId: string | null;
  /** Set to true while this dropdown is open — see TiptapProviderProps. */
  suggestionOpenRef?: { current: boolean };
}

interface SlashItem extends BaseItem {
  kind: "prompt" | "resource" | "skill";
  /** For resources */
  uri?: string;
  /** For prompts - arguments definition */
  arguments?: Prompt["arguments"];
  /** For prompts - MCP metadata */
  _meta?: Prompt["_meta"];
  /** For skills - the catalog entry used to fetch SKILL.md on select. */
  skill?: OrgFsSkillCatalogEntry;
}

/** Metadata stashed on a skill mention; consumed by derive-parts. */
export interface SkillMentionMeta {
  /** Sandbox dir the skill's files are mounted under (for omitted files). */
  sandboxPath: string;
  /** Markdown/text docs, inlined (content baked) at select time. */
  files: OrgFsSkillFile[];
  /** Relative paths of files left on disk (scripts/assets/oversized). */
  omittedPaths: string[];
}

interface PromptSelectContext {
  range: Range;
  item: SlashItem;
}

interface EditingMention {
  promptId: string;
  promptName: string;
  args: Record<string, string>;
  pos: number;
  prompt: Prompt;
}

interface FetcherDeps {
  t: ReturnType<typeof useT>;
}

async function fetchAndInsertPrompt(
  editor: Editor,
  range: Range,
  client: Client,
  promptName: string,
  clientId: string | undefined,
  values: PromptArgumentValues | undefined,
  deps: FetcherDeps,
) {
  try {
    const result = await getPrompt(client, promptName, values);

    insertMention(editor, range, {
      id: promptName,
      name: stripToolNamespace(promptName, clientId),
      metadata: result.messages,
      char: "/",
      kind: "prompt",
      args: values,
    });
  } catch (error) {
    console.error("[slash] Failed to fetch prompt:", error);
    toast.error(deps.t("chat.mentionSlash.failedLoadPrompt"));
  }
}

async function fetchAndInsertResource(
  editor: Editor,
  range: Range,
  client: Client,
  resourceUri: string,
  deps: FetcherDeps,
) {
  try {
    const result = await readResource(client, resourceUri);

    insertMention(editor, range, {
      id: resourceUri,
      name: resourceUri,
      metadata: result.contents,
      char: "/",
      kind: "resource",
    });
  } catch (error) {
    console.error("[slash] Failed to fetch resource:", error);
    toast.error(deps.t("chat.mentionSlash.failedLoadResource"));
  }
}

async function fetchAndInsertSkill(
  editor: Editor,
  range: Range,
  orgSlug: string,
  skill: OrgFsSkillCatalogEntry,
  deps: FetcherDeps,
) {
  try {
    const { files, omittedPaths } = await fetchOrgFsSkillFiles(
      orgSlug,
      skill.volume,
      skill.path,
    );
    const metadata: SkillMentionMeta = {
      sandboxPath: skill.sandboxPath,
      files,
      omittedPaths,
    };
    insertMention(editor, range, {
      id: skill.id,
      name: skill.name,
      metadata,
      char: "/",
      kind: "skill",
    });
  } catch (error) {
    console.error("[slash] Failed to fetch skill:", error);
    toast.error(deps.t("chat.mentionSlash.failedLoadSkill"));
  }
}

export const SlashMention = ({
  editor,
  virtualMcpId,
  suggestionOpenRef,
}: SlashMentionProps) => {
  const t = useT();
  const queryClient = useQueryClient();
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: virtualMcpId,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const promptsQueryKey = KEYS.virtualMcpPrompts(virtualMcpId, org.id);
  const resourcesQueryKey = KEYS.virtualMcpResources(virtualMcpId, org.id);
  // Skill catalog is org-scoped (not per-MCP): home + public sets.
  const skillsQueryKey = KEYS.slashSkills(org.id);
  // Combined key for the suggestion dropdown
  const queryKey = [
    "slash-mention",
    org.id,
    virtualMcpId ?? "default",
  ] as const;

  const [activePrompt, setActivePrompt] = useState<PromptSelectContext | null>(
    null,
  );
  const [editingMention, setEditingMention] = useState<EditingMention | null>(
    null,
  );

  // Bridge for chip clicks → edit dialog. The storage on the MentionNode
  // extension is read by `MentionNodeView`; we assign the callback directly
  // on every render so it always closes over the latest `client` / query state.
  const mentionStorage = getMentionStorage(editor);
  if (mentionStorage) {
    mentionStorage.onEditChip = async (req: EditMentionRequest) => {
      if (!client) return;
      try {
        const prompts = await fetchPrompts(
          queryClient,
          promptsQueryKey,
          client,
        );
        const prompt = prompts.find((p) => p.name === req.promptId);
        if (!prompt?.arguments || prompt.arguments.length === 0) return;
        setEditingMention({ ...req, prompt });
      } catch (error) {
        console.error("[slash] Failed to load prompt for editing:", error);
        toast.error(t("chat.mentionSlash.failedLoadPrompt"));
      }
    };
  }

  // Track picker open → close outcome so we can measure abandonment.
  const pickerOpenedAtRef = useRef<number | null>(null);
  const pickerHadSelectionRef = useRef(false);

  const handleItemSelect = async ({
    item,
    range,
  }: OnSelectProps<SlashItem>) => {
    track("chat_picker_item_selected", {
      picker: "/",
      item_kind: item.kind,
      item_name: item.name,
    });
    pickerHadSelectionRef.current = true;

    if (!client) return;

    if (item.kind === "prompt") {
      // If prompt has arguments, open dialog
      if (item.arguments && item.arguments.length > 0) {
        setActivePrompt({ range, item });
        return;
      }
      const clientId = getGatewayClientId(item._meta);
      await fetchAndInsertPrompt(
        editor,
        range,
        client,
        item.name,
        clientId,
        undefined,
        { t },
      );
    } else if (item.kind === "skill") {
      if (item.skill) {
        await fetchAndInsertSkill(editor, range, org.slug, item.skill, { t });
      }
    } else {
      // Resource
      if (item.uri) {
        await fetchAndInsertResource(editor, range, client, item.uri, { t });
      }
    }
  };

  const handleDialogSubmit = async (values: PromptArgumentValues) => {
    if (!activePrompt || !client) return;

    const { range, item } = activePrompt;
    const clientId = getGatewayClientId(item._meta);
    await fetchAndInsertPrompt(
      editor,
      range,
      client,
      item.name,
      clientId,
      values,
      { t },
    );
    setActivePrompt(null);
  };

  const handleEditDialogSubmit = async (newValues: PromptArgumentValues) => {
    if (!editingMention || !client) return;
    // The dialog captured `pos` when the chip was clicked; the doc may have
    // changed since (chip deleted, text shifted) while the prompt fetch and
    // the dialog were open. Bail instead of crashing the editor on a stale pos.
    if (!isMentionNodeAt(editor, editingMention.pos, editingMention.promptId)) {
      toast.error(t("chat.mentionSlash.failedUpdatePrompt"));
      setEditingMention(null);
      return;
    }
    try {
      const result = await getPrompt(
        client,
        editingMention.promptId,
        newValues,
      );
      const clientId = getGatewayClientId(editingMention.prompt._meta);
      editor
        .chain()
        .focus()
        .setNodeSelection(editingMention.pos)
        .deleteSelection()
        .insertContentAt(
          editingMention.pos,
          createMentionDoc({
            id: editingMention.promptId,
            name: stripToolNamespace(editingMention.promptId, clientId),
            metadata: result.messages,
            char: "/",
            kind: "prompt",
            args: newValues,
          }),
        )
        .run();
      track("chat_picker_item_selected", {
        picker: "/edit",
        item_kind: "prompt",
        item_name: editingMention.promptId,
      });
    } catch (error) {
      console.error("[slash] Failed to update prompt:", error);
      toast.error(t("chat.mentionSlash.failedUpdatePrompt"));
    }
    setEditingMention(null);
  };

  const fetchItems = async (props: { query: string }): Promise<SlashItem[]> => {
    const { query } = props;
    if (!client) return [];

    // Fetch prompts, resources, and skills in parallel
    const [prompts, resources, skills] = await Promise.all([
      fetchPrompts(queryClient, promptsQueryKey, client),
      fetchResources(queryClient, resourcesQueryKey, client),
      fetchSkills(queryClient, skillsQueryKey, org.slug),
    ]);

    const lowerQuery = query.trim().toLowerCase();

    // Build prompt items
    const promptItems: SlashItem[] = (prompts ?? [])
      .filter(
        (p) =>
          !lowerQuery ||
          p.name.toLowerCase().includes(lowerQuery) ||
          p.title?.toLowerCase().includes(lowerQuery) ||
          p.description?.toLowerCase().includes(lowerQuery),
      )
      .map((p) => ({
        name: p.name,
        title: p.title,
        description: p.description,
        kind: "prompt" as const,
        arguments: p.arguments,
        _meta: p._meta,
      }));

    // Build resource items
    const resourceItems: SlashItem[] = (resources ?? [])
      .filter(
        (r) =>
          !lowerQuery ||
          r.uri.toLowerCase().includes(lowerQuery) ||
          r.name?.toLowerCase().includes(lowerQuery) ||
          r.description?.toLowerCase().includes(lowerQuery),
      )
      .map((r) => ({
        name: r.name ?? r.uri,
        title: r.name,
        description: r.description,
        kind: "resource" as const,
        uri: r.uri,
      }));

    // Build skill items (public sets + org home, incl. storefront)
    const skillItems: SlashItem[] = (skills ?? [])
      .filter(
        (s) =>
          !lowerQuery ||
          s.name.toLowerCase().includes(lowerQuery) ||
          s.id.toLowerCase().includes(lowerQuery) ||
          s.description?.toLowerCase().includes(lowerQuery),
      )
      .map((s) => ({
        name: s.name,
        title: s.name,
        description: s.description ?? undefined,
        kind: "skill" as const,
        skill: s,
      }));

    // Prompts first, then resources, then skills
    return [...promptItems, ...resourceItems, ...skillItems];
  };

  // Build a dialog-compatible prompt object from SlashItem
  const dialogPrompt =
    activePrompt?.item.kind === "prompt"
      ? ({
          name: activePrompt.item.name,
          title: activePrompt.item.title,
          arguments: activePrompt.item.arguments,
          description: activePrompt.item.description,
          _meta: activePrompt.item._meta,
        } as Prompt)
      : null;

  return (
    <>
      <Suggestion<SlashItem>
        editor={editor}
        char="/"
        pluginKey="slashDropdownMenu"
        queryKey={queryKey}
        queryFn={fetchItems}
        onSelect={handleItemSelect}
        onOpenChange={(open) => {
          if (suggestionOpenRef) suggestionOpenRef.current = open;
          // Fires when the / picker dropdown actually renders (TipTap's
          // onStart). NOT when a literal "/" is typed — e.g. inside a URL
          // the picker won't open so the event won't fire.
          if (open) {
            pickerOpenedAtRef.current = Date.now();
            pickerHadSelectionRef.current = false;
            track("chat_picker_opened", { picker: "/" });
          } else {
            const openedAt = pickerOpenedAtRef.current;
            track("chat_picker_closed", {
              picker: "/",
              outcome: pickerHadSelectionRef.current ? "selected" : "dismissed",
              duration_ms: openedAt ? Date.now() - openedAt : null,
            });
            pickerOpenedAtRef.current = null;
          }
        }}
      />
      <PromptArgsDialog
        prompt={dialogPrompt}
        setPrompt={() => setActivePrompt(null)}
        onSubmit={handleDialogSubmit}
      />
      <PromptArgsDialog
        key={
          editingMention
            ? `edit-${editingMention.promptId}-${editingMention.pos}`
            : "edit-idle"
        }
        prompt={editingMention?.prompt ?? null}
        setPrompt={() => setEditingMention(null)}
        onSubmit={handleEditDialogSubmit}
        defaultValues={editingMention?.args}
      />
    </>
  );
};

// ── Helpers ──────────────────────────────────────────────────────────────

async function fetchPrompts(
  queryClient: ReturnType<typeof useQueryClient>,
  queryKey: readonly unknown[],
  client: Client,
) {
  let cached = queryClient.getQueryData<ListPromptsResult>(queryKey);
  if (!cached) {
    cached = await queryClient.fetchQuery({
      queryKey,
      queryFn: () => listPrompts(client),
      staleTime: 60000,
    });
  } else {
    queryClient
      .fetchQuery({
        queryKey,
        queryFn: () => listPrompts(client),
        staleTime: 60000,
      })
      .catch(() => {});
  }
  return cached?.prompts ?? [];
}

async function fetchSkills(
  queryClient: ReturnType<typeof useQueryClient>,
  queryKey: readonly unknown[],
  orgSlug: string,
): Promise<OrgFsSkillCatalogEntry[]> {
  const cached = queryClient.getQueryData<OrgFsSkillCatalogEntry[]>(queryKey);
  const revalidate = () =>
    queryClient.fetchQuery({
      queryKey,
      queryFn: () => fetchOrgFsSkillCatalog(orgSlug),
      staleTime: 60000,
    });
  // Skills are additive — a fetch failure (e.g. missing ORG_FS_READ) must never
  // take down the whole "/" picker (prompts + resources), so degrade to [].
  if (!cached) return revalidate().catch(() => []);
  revalidate().catch(() => {});
  return cached;
}

async function fetchResources(
  queryClient: ReturnType<typeof useQueryClient>,
  queryKey: readonly unknown[],
  client: Client,
) {
  let cached = queryClient.getQueryData<ListResourcesResult>(queryKey);
  if (!cached) {
    cached = await queryClient.fetchQuery({
      queryKey,
      queryFn: () => listResources(client),
      staleTime: 60000,
    });
  } else {
    queryClient
      .fetchQuery({
        queryKey,
        queryFn: () => listResources(client),
        staleTime: 60000,
      })
      .catch(() => {});
  }
  return cached?.resources ?? [];
}
