import { formatDistanceToNow } from "date-fns";
import { ptBR as ptBRLocale } from "date-fns/locale/pt-BR";
import { generatePrefixedId } from "@decocms/shared/utils/generate-id";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { useChatStream } from "@/components/chat/context";
import { buildImprovePromptDoc } from "@/components/chat/tiptap/build-improve-prompt-doc";
import { EmptyState } from "@/components/empty-state.tsx";
import { ErrorBoundary } from "@/components/error-boundary";
import { usePanelActions } from "@/layouts/shell-layout";
import { User } from "@/components/user/user";
import { useT } from "@/i18n/use-t.ts";
import { usePreferences } from "@/hooks/use-preferences.ts";

import { authenticateMcp, isConnectionAuthenticated } from "@/lib/mcp-oauth";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@decocms/ui/components/alert-dialog.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Card, CardContent } from "@decocms/ui/components/card.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import {
  ENV_VAR_KEY_RE,
  StudioPackAgentId,
  SUBMODULE_HOST_RE,
  useConnectionActions,
  useProjectContext,
  useVirtualMCP,
  useVirtualMCPActions,
  useVirtualMCPsLastUsed,
} from "@/sdk";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Maximize01, Play, Plus, Stars01, Trash01 } from "@untitledui/icons";
import { Suspense, useEffect, useReducer, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useDebouncedAutosave } from "@/hooks/use-debounced-autosave.ts";
import { toast } from "sonner";
import { IconPicker } from "../../components/icon-picker";
import { Page } from "@/components/page";
import { AddConnectionDialog } from "./add-connection-dialog";
import { FilesSection } from "./files-section";
import { SubAgentsSection } from "./sub-agents-section";
import { track } from "@/lib/posthog-client";
import { DependencySelectionDialog } from "./dependency-selection-dialog";
import { ConnectionItem, ConnectionItemSkeleton } from "./connection-item";
import { LayoutTabContent } from "./layout-tab-content";
import { ALL_ITEMS_SELECTED } from "./selection-utils";
import { VirtualMcpFormSchema, type VirtualMcpFormData } from "./types";
import { VirtualMCPShareModal } from "./virtual-mcp-share-modal";
import { getActiveGithubRepo } from "@/lib/github-repo";
import {
  agentHasClonableSource,
  agentHasConnectedGithub,
} from "@/lib/agent-capabilities";
import { DevAgentSetup } from "@/components/dev-agent/dev-agent-setup.tsx";
import { EnvVarsField } from "@/components/sandbox/runtime-card/env-vars-field";
import { SubmoduleCredentialsField } from "@/components/sandbox/runtime-card/submodule-credentials-field";
import { RepoRow } from "@/components/sandbox/runtime-card/repo-row";
import { RuntimeFields } from "@/components/sandbox/runtime-card/runtime-fields";
import { PreviewServerUrlField } from "@/components/sandbox/runtime-card/preview-server-url-field";
import { resolvePreviewServerUrl } from "@decocms/shared/deco-site-production-url";
import { FieldDescriptionTooltipsField } from "@/components/sandbox/runtime-card/field-description-tooltips-field";
import { FastPreviewField } from "@/components/sandbox/runtime-card/fast-preview-field";
import { PublishPolicyField } from "./publish-policy-field";

type DialogState = {
  shareDialogOpen: boolean;
  addDialogOpen: boolean;
  settingsDialogOpen: boolean;
  settingsConnectionId: string | null;
};

type DialogAction =
  | { type: "SET_SHARE_DIALOG_OPEN"; payload: boolean }
  | { type: "SET_ADD_DIALOG_OPEN"; payload: boolean }
  | { type: "OPEN_SETTINGS"; payload: string }
  | { type: "CLOSE_SETTINGS" };

function dialogReducer(state: DialogState, action: DialogAction): DialogState {
  switch (action.type) {
    case "SET_SHARE_DIALOG_OPEN":
      return { ...state, shareDialogOpen: action.payload };
    case "SET_ADD_DIALOG_OPEN":
      return { ...state, addDialogOpen: action.payload };
    case "OPEN_SETTINGS":
      return {
        ...state,
        settingsDialogOpen: true,
        settingsConnectionId: action.payload,
      };
    case "CLOSE_SETTINGS":
      return {
        ...state,
        settingsDialogOpen: false,
        settingsConnectionId: null,
      };
    default:
      return state;
  }
}

type EditSession = {
  start: number;
  fields: Set<string>;
  saveCount: number;
  instructionsLength: number | null;
};

type EditSessionAction =
  | {
      type: "accumulate";
      now: number;
      fields: string[];
      instructionsLength: number | null;
    }
  | { type: "reset" };

function editSessionReducer(
  state: EditSession | null,
  action: EditSessionAction,
): EditSession | null {
  switch (action.type) {
    case "accumulate": {
      const base: EditSession = state ?? {
        start: action.now,
        fields: new Set(),
        saveCount: 0,
        instructionsLength: null,
      };
      const fields = new Set(base.fields);
      for (const f of action.fields) fields.add(f);
      return {
        ...base,
        fields,
        saveCount: base.saveCount + 1,
        instructionsLength:
          action.instructionsLength ?? base.instructionsLength,
      };
    }
    case "reset":
      return null;
  }
}

/**
 * Drops in-progress / invalid env rows from the autosave payload. A row is
 * stripped when: key is empty, key fails the shell-portable regex, or it's a
 * secret-kind row with no secretId. The partial/invalid row stays in form
 * state so the user can keep editing; the server-side Zod schema would
 * reject these anyway and we'd surface a noisy validation error on every
 * keystroke without this filter.
 */
function stripIncompleteEnvEntries(
  data: VirtualMcpFormData,
): VirtualMcpFormData {
  const env = data.metadata?.runtime?.env;
  if (!env || env.length === 0) return data;
  const cleaned = env.filter((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const key = ((entry as { key?: string }).key ?? "").trim();
    if (!key || !ENV_VAR_KEY_RE.test(key)) return false;
    if (entry.kind === "literal") return true;
    if (entry.kind === "secret") {
      return Boolean((entry as { secretId?: string }).secretId);
    }
    return false;
  });
  if (cleaned.length === env.length) return data;
  return {
    ...data,
    metadata: {
      ...data.metadata,
      runtime: {
        ...(data.metadata?.runtime ?? {}),
        env: cleaned,
      },
    },
  };
}

/**
 * Drop half-filled submodule-credential rows (no host, invalid host, or no
 * secretId) before autosave, same rationale as `stripIncompleteEnvEntries`:
 * the partial row stays in form state so the user keeps editing, but the
 * request body only carries entries the server schema accepts.
 */
function stripIncompleteSubmoduleCredentials(
  data: VirtualMcpFormData,
): VirtualMcpFormData {
  const creds = data.metadata?.runtime?.submoduleCredentials;
  if (!creds || creds.length === 0) return data;
  const cleaned = creds.filter((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const host = ((entry as { host?: string }).host ?? "").trim();
    if (!host || !SUBMODULE_HOST_RE.test(host)) return false;
    return Boolean((entry as { secretId?: string }).secretId);
  });
  if (cleaned.length === creds.length) return data;
  return {
    ...data,
    metadata: {
      ...data.metadata,
      runtime: {
        ...(data.metadata?.runtime ?? {}),
        submoduleCredentials: cleaned,
      },
    },
  };
}

async function extractEmailFromTokenInfo(
  tokenInfo: {
    idToken: string | null;
    userinfoEndpoint: string | null;
    accessToken: string;
  } | null,
  accessToken: string,
): Promise<string | null> {
  // 1. Try to decode the OIDC id_token JWT (fastest, no extra request)
  const jwtToTry = tokenInfo?.idToken ?? null;
  if (jwtToTry) {
    const email = decodeJwtEmail(jwtToTry);
    if (email) return email;
  }

  // 2. Call the OIDC userinfo endpoint if available (works for Google Drive which returns opaque access tokens)
  const userinfoEndpoint = tokenInfo?.userinfoEndpoint ?? null;
  if (userinfoEndpoint) {
    try {
      const res = await fetch(userinfoEndpoint, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.ok) {
        const userinfo = (await res.json()) as Record<string, unknown>;
        const email =
          typeof userinfo.email === "string"
            ? userinfo.email
            : typeof userinfo.upn === "string"
              ? userinfo.upn
              : typeof userinfo.preferred_username === "string"
                ? userinfo.preferred_username
                : null;
        if (email) return email;
      }
    } catch {
      // Ignore — userinfo endpoint unavailable or CORS blocked
    }
  }

  // 3. Last resort: try to decode the access token itself as a JWT
  return decodeJwtEmail(accessToken);
}

function decodeJwtEmail(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length === 3 && parts[1]) {
      const payload = JSON.parse(
        atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
      ) as Record<string, unknown>;
      if (typeof payload.email === "string") return payload.email;
      if (typeof payload.upn === "string") return payload.upn;
      if (typeof payload.preferred_username === "string")
        return payload.preferred_username;
    }
  } catch {
    // Not a decodable JWT
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main detail view
// ---------------------------------------------------------------------------

function VirtualMcpDetailViewWithData({
  virtualMcp,
  hideOwnTitle,
}: {
  virtualMcp: VirtualMCPEntity;
  hideOwnTitle?: boolean;
}) {
  const t = useT();
  const [preferences] = usePreferences();
  const locale = preferences.language === "pt-BR" ? ptBRLocale : undefined;
  const { org } = useProjectContext();
  const actions = useVirtualMCPActions();
  const { data: lastUsedMap } = useVirtualMCPsLastUsed([virtualMcp.id]);
  const lastUsedAt = lastUsedMap?.get(virtualMcp.id)?.last_used_at;
  const connectionActions = useConnectionActions();
  const queryClient = useQueryClient();
  const studio = useStudioTools();

  // Form setup. Seed `metadata.previewServerUrl` through the dual-read
  // resolver so a project persisted under the legacy `productionUrl` key
  // shows its value — and migrates it to the new key on the next save.
  const form = useForm<VirtualMcpFormData>({
    resolver: zodResolver(VirtualMcpFormSchema),
    defaultValues: {
      ...virtualMcp,
      metadata: {
        ...virtualMcp.metadata,
        previewServerUrl: resolvePreviewServerUrl(virtualMcp.metadata),
      },
    },
  });

  // Watch connections for reactive UI
  const connections = form.watch("connections");

  // GitHub repo connected (real auth) — instructions become read-only
  const hasGithubRepo = agentHasConnectedGithub(virtualMcp);

  // Gates the "Open CMS" toggle — same condition LayoutTabContent uses to
  // gate Preview/Content as a main-view option (a Start Website template or a
  // connected GitHub repo).
  const hasClonableSource = agentHasClonableSource(virtualMcp?.metadata);
  const layoutMeta = form.watch("metadata.ui.layout") ?? null;
  // Off by default (absent / null → false): the CMS auto-opens in Preview only
  // when an agent explicitly opts in via this toggle.
  const cmsDefaultOpen = layoutMeta?.cmsDefaultOpen ?? false;

  // Repo info for the Runtime card (display-only — loose check is intentional)
  const githubRepoForRuntimeCard = getActiveGithubRepo(virtualMcp);
  const runtimeCardRepo = githubRepoForRuntimeCard
    ? {
        owner: githubRepoForRuntimeCard.owner,
        name: githubRepoForRuntimeCard.name,
        url: githubRepoForRuntimeCard.url,
      }
    : null;

  // Dialog states
  const [dialogState, dispatch] = useReducer(dialogReducer, {
    shareDialogOpen: false,
    addDialogOpen: false,
    settingsDialogOpen: false,
    settingsConnectionId: null,
  });

  const [instructionsFullscreen, setInstructionsFullscreen] = useState(false);
  const [isImproving, setIsImproving] = useState(false);
  const { createNewTask, openSidePanel } = usePanelActions();
  const { sendMessage } = useChatStream();

  const handleImprovePrompt = async () => {
    if (isImproving) return;
    const currentInstructions = form.getValues("metadata.instructions");
    if (!currentInstructions?.trim()) return;

    setIsImproving(true);
    try {
      forceSessionFlush();
      track("agent_instructions_improve_clicked", {
        agent_id: virtualMcp.id,
        instructions_length: currentInstructions.length,
      });

      openSidePanel("chat");

      await sendMessage({
        tiptapDoc: buildImprovePromptDoc({
          managerAgentId: StudioPackAgentId.AGENT_MANAGER(org.id),
          managerName: "Agent Manager",
          kind: "agent",
          id: virtualMcp.id,
          instructions: currentInstructions,
        }),
      });
    } finally {
      setIsImproving(false);
    }
  };

  const handleTestAgent = () => {
    forceSessionFlush();
    track("agent_test_clicked", { agent_id: virtualMcp.id });
    createNewTask();
  };

  // Session-based tracking for agent_updated. Auto-saves persist every ~1s but
  // we only emit one PostHog event per edit-session (aggregated fields +
  // save_count + edit_duration_ms). A session ends after 30s of quiet.
  const [editSession, dispatchEditSession] = useReducer(
    editSessionReducer,
    null,
  );

  const flushEditSession = () => {
    if (editSession === null) return;
    track("agent_updated", {
      agent_id: virtualMcp.id,
      fields: Array.from(editSession.fields),
      instructions_length: editSession.instructionsLength,
      save_count: editSession.saveCount,
      edit_duration_ms: Date.now() - editSession.start,
    });
    dispatchEditSession({ type: "reset" });
  };

  const { schedule: scheduleSessionFlush, flush: forceSessionFlush } =
    useDebouncedAutosave({
      delayMs: 30_000,
      save: async () => flushEditSession(),
    });

  const saveForm = async () => {
    // form.formState is a Proxy over React state. When saveForm runs
    // synchronously after setValue (e.g. via flushAndSave), React hasn't
    // processed the batched state update yet and form.formState.dirtyFields
    // returns the previous render's snapshot — empty on the first edit — so
    // the save would bail. Read control._formState.dirtyFields for the live,
    // synchronously-updated value.
    const dirtyKeys = Object.keys(
      (
        form.control as unknown as {
          _formState: { dirtyFields: Record<string, unknown> };
        }
      )._formState.dirtyFields,
    );
    if (dirtyKeys.length === 0) return;
    const instructionsDirty = dirtyKeys.includes("metadata");

    const formData = form.getValues();
    // Rebase the dirty baseline to the snapshot we're about to send so that
    // an edit during the in-flight save that returns a value to its pre-save
    // default still registers as dirty. keepValues preserves the user's
    // current form values; only _defaultValues advances.
    form.reset(formData, { keepValues: true });

    // Strip in-progress env rows (no key, or kind=secret with no secretId) and
    // submodule-credential rows (no host / no secretId). The partial rows stay
    // in form state so the user keeps editing, but the request body only
    // carries entries the server schema accepts.
    const payload = stripIncompleteSubmoduleCredentials(
      stripIncompleteEnvEntries(formData),
    );

    await actions.update.mutateAsync({
      id: virtualMcp.id,
      data: payload,
    });

    // Accumulate into the current edit session and (re)schedule a flush
    // 30s after the last save.
    dispatchEditSession({
      type: "accumulate",
      now: Date.now(),
      fields: dirtyKeys,
      instructionsLength: instructionsDirty
        ? (formData.metadata?.instructions?.length ?? 0)
        : null,
    });
    scheduleSessionFlush();
  };

  const { schedule: debouncedSave, flush: flushAndSave } = useDebouncedAutosave(
    { save: saveForm },
  );

  // form.watch(callback) fires whenever a value changes via setValue, but not
  // on form.reset({ keepValues: true }) (which only emits state, no `values`
  // key) — so saveForm's pre-mutate rebase does NOT loop. Edit handlers
  // can just call form.setValue and trust this subscription to schedule the
  // save. flushAndSave remains for explicit "save NOW" semantics (blurs,
  // toggles).
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    const sub = form.watch(() => debouncedSave());
    return () => sub.unsubscribe();
    // debouncedSave is stable for our purpose: its closure only mediates
    // through stable refs inside useDebouncedAutosave, so the mount-time
    // reference stays valid for the component's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleOpenAddDialog = () => {
    track("connections_dialog_opened", {
      source: "agent_settings",
      mode: "add",
    });
    dispatch({ type: "SET_ADD_DIALOG_OPEN", payload: true });
  };

  const handleAddConnection = async (connectionId: string) => {
    const current = form.getValues("connections");
    // Don't add duplicates
    if (current.some((c) => c.connection_id === connectionId)) return;

    form.setValue(
      "connections",
      [
        ...current,
        {
          connection_id: connectionId,
          selected_tools: ALL_ITEMS_SELECTED.tools,
          selected_resources: ALL_ITEMS_SELECTED.resources,
          selected_prompts: ALL_ITEMS_SELECTED.prompts,
        },
      ],
      { shouldDirty: true },
    );
    dispatch({ type: "SET_ADD_DIALOG_OPEN", payload: false });

    // Auto-trigger OAuth if the connection needs authorization
    const mcpProxyUrl = new URL(
      `/api/${org.slug}/mcp/${connectionId}`,
      window.location.origin,
    );
    const authStatus = await isConnectionAuthenticated({
      url: mcpProxyUrl.href,
      token: null,
      orgId: org.id,
    });
    if (authStatus.supportsOAuth && !authStatus.isAuthenticated) {
      await handleAuthenticate(connectionId);
    }
  };

  const handleRemoveConnection = (connectionId: string) => {
    const current = form.getValues("connections");
    const filtered = current.filter((c) => c.connection_id !== connectionId);
    form.setValue("connections", filtered, { shouldDirty: true });
  };

  const handleSwitchInstance = (oldId: string, newId: string) => {
    const current = form.getValues("connections");
    // Prevent switching to an instance already used in this agent
    if (current.some((c) => c.connection_id === newId)) {
      toast.error(t("virtualMcp.virtualMcp.instanceAlreadyAdded"));
      return;
    }
    form.setValue(
      "connections",
      current.map((c) =>
        c.connection_id === oldId ? { ...c, connection_id: newId } : c,
      ),
      { shouldDirty: true },
    );
  };

  const handleNewInstance = async (connectionId: string) => {
    const connection = form
      .getValues("connections")
      .find((c) => c.connection_id === connectionId);
    if (!connection) return;

    // We need the full connection entity to clone from
    try {
      const { item: base } = await studio.call("COLLECTION_CONNECTIONS_GET", {
        id: connectionId,
      });
      if (!base) return;

      const baseName = base.title.replace(/\s*\(.*?\)\s*$/, "");
      const newId = generatePrefixedId("conn");
      // Temporary title — will be updated with email suffix after OAuth if available
      const tempTitle = `${baseName} (${Date.now().toString(36).slice(-4)})`;

      await connectionActions.create.mutateAsync({
        id: newId,
        title: tempTitle,
        description: base.description ?? null,
        connection_type: base.connection_type,
        connection_url: base.connection_url ?? null,
        connection_token: null,
        icon: base.icon ?? null,
        app_name: base.app_name ?? null,
        app_id: base.app_id ?? null,
        connection_headers: base.connection_headers ?? null,
      });

      // Handle OAuth if needed
      const mcpProxyUrl = new URL(
        `/api/${org.slug}/mcp/${newId}`,
        window.location.origin,
      );
      const authStatus = await isConnectionAuthenticated({
        url: mcpProxyUrl.href,
        token: null,
        orgId: org.id,
      });
      if (authStatus.supportsOAuth && !authStatus.isAuthenticated) {
        const email = await handleAuthenticate(newId);
        if (!email) {
          // Auth failed or cancelled — clean up the orphaned connection
          await connectionActions.delete.mutateAsync(newId);
          return;
        }
        await connectionActions.update.mutateAsync({
          id: newId,
          data: { title: `${baseName} (${email})` },
        });
      }

      // Switch to the new instance
      handleSwitchInstance(connectionId, newId);
      toast.success(t("virtualMcp.virtualMcp.newInstanceCreated"));
    } catch (err) {
      console.error("Failed to create instance:", err);
      toast.error(t("virtualMcp.virtualMcp.failedToCreateInstance"));
    }
  };

  const handleOpenSettings = (connectionId: string) => {
    dispatch({ type: "OPEN_SETTINGS", payload: connectionId });
  };

  const handleAuthenticate = async (
    connectionId: string,
  ): Promise<string | null> => {
    const { token, tokenInfo, error } = await authenticateMcp({
      connectionId,
      orgSlug: org.slug,
      scope: "offline_access",
    });
    if (error || !token) {
      toast.error(
        t("virtualMcp.virtualMcp.authenticationFailed", { error: error ?? "" }),
      );
      return null;
    }

    if (tokenInfo) {
      try {
        const response = await fetch(
          `/api/${org.slug}/connections/${connectionId}/oauth-token`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            credentials: "include",
            body: JSON.stringify({
              accessToken: tokenInfo.accessToken,
              refreshToken: tokenInfo.refreshToken,
              expiresIn: tokenInfo.expiresIn,
              scope: tokenInfo.scope,
              clientId: tokenInfo.clientId,
              clientSecret: tokenInfo.clientSecret,
              tokenEndpoint: tokenInfo.tokenEndpoint,
            }),
          },
        );
        if (!response.ok) {
          console.error("Failed to save OAuth token:", await response.text());
          await connectionActions.update.mutateAsync({
            id: connectionId,
            data: { connection_token: token },
          });
        } else {
          try {
            await connectionActions.update.mutateAsync({
              id: connectionId,
              data: {},
            });
          } catch (err) {
            console.warn(
              "Failed to refresh connection tools after OAuth:",
              err,
            );
          }
        }
      } catch (err) {
        console.error("Error saving OAuth token:", err);
        await connectionActions.update.mutateAsync({
          id: connectionId,
          data: { connection_token: token },
        });
      }
    } else {
      await connectionActions.update.mutateAsync({
        id: connectionId,
        data: { connection_token: token },
      });
    }

    const mcpProxyUrl = new URL(
      `/api/${org.slug}/mcp/${connectionId}`,
      window.location.origin,
    );
    await queryClient.invalidateQueries({
      queryKey: KEYS.isMCPAuthenticated(mcpProxyUrl.href, null),
    });

    toast.success(t("virtualMcp.virtualMcp.authenticationSuccessful"));

    return extractEmailFromTokenInfo(tokenInfo, token);
  };

  const handleInsertTemplate = () => {
    const current = form.getValues("metadata.instructions") ?? "";
    const template = t("virtualMcp.virtualMcp.promptTemplateContent");
    const next = current.trim() ? `${current}\n\n${template}` : template;
    form.setValue("metadata.instructions", next, { shouldDirty: true });
  };

  const addedConnectionIds = new Set(connections.map((c) => c.connection_id));
  const navigate = useNavigate();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const handleDelete = async () => {
    forceSessionFlush();
    try {
      await actions.delete.mutateAsync(virtualMcp.id);
      track("agent_deleted", {
        agent_id: virtualMcp.id,
        source: "agent_detail",
      });
      toast.success(
        t("virtualMcp.virtualMcp.agentDeleted", { title: virtualMcp.title }),
      );
      navigate({ to: "/$org", params: { org: org.slug } });
    } catch {
      // Error toast handled by mutation
    }
  };

  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <div className="flex flex-col gap-10">
            {!hideOwnTitle && (
              <Page.Title
                actions={
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleTestAgent}
                    >
                      <Play size={14} className="size-[14px]!" />
                      {t("virtualMcp.virtualMcp.testAgent")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => setDeleteDialogOpen(true)}
                    >
                      <Trash01 size={14} />
                    </Button>
                  </div>
                }
              >
                {t("virtualMcp.virtualMcp.settings")}
              </Page.Title>
            )}

            {/* Agent identity header */}
            <div className="flex items-center gap-3">
              <Controller
                name="icon"
                control={form.control}
                render={({ field }) => (
                  <IconPicker
                    value={field.value ?? null}
                    onChange={(icon) => {
                      field.onChange(icon);
                      flushAndSave();
                    }}
                    onColorChange={(color) => {
                      form.setValue("metadata.ui.themeColor", color, {
                        shouldDirty: true,
                      });
                      flushAndSave();
                    }}
                    name={form.watch("title") || "Agent"}
                    size="md"
                    className="shrink-0"
                    avatarClassName="[&_svg]:w-1/2 [&_svg]:h-1/2"
                  />
                )}
              />
              <div className="flex flex-col flex-1 min-w-0">
                <Controller
                  name="title"
                  control={form.control}
                  render={({ field }) => (
                    <input
                      {...field}
                      type="text"
                      value={field.value ?? ""}
                      onChange={(e) => {
                        field.onChange(e);
                      }}
                      onBlur={() => {
                        field.onBlur();
                        flushAndSave();
                      }}
                      disabled={hasGithubRepo}
                      placeholder={t(
                        "virtualMcp.virtualMcp.agentNamePlaceholder",
                      )}
                      className="text-lg font-medium leading-tight text-foreground bg-transparent border-none outline-none px-1 -mx-1 rounded hover:bg-input/25 focus:bg-input/25 transition-colors w-full truncate disabled:hover:bg-transparent disabled:focus:bg-transparent disabled:opacity-50"
                    />
                  )}
                />
                <Controller
                  name="description"
                  control={form.control}
                  render={({ field }) => (
                    <input
                      {...field}
                      type="text"
                      value={field.value ?? ""}
                      onChange={(e) => {
                        field.onChange(e);
                      }}
                      onBlur={() => {
                        field.onBlur();
                        flushAndSave();
                      }}
                      disabled={hasGithubRepo}
                      placeholder={t(
                        "virtualMcp.virtualMcp.descriptionPlaceholder",
                      )}
                      className="text-sm text-muted-foreground bg-transparent border-none outline-none px-1 -mx-1 rounded hover:bg-input/25 focus:bg-input/25 transition-colors w-full truncate disabled:hover:bg-transparent disabled:focus:bg-transparent disabled:opacity-50"
                    />
                  )}
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => {
                  track("agent_connect_modal_opened", {
                    agent_id: virtualMcp.id,
                  });
                  dispatch({
                    type: "SET_SHARE_DIALOG_OPEN",
                    payload: true,
                  });
                }}
              >
                <span className="flex items-center -space-x-1.5 mr-0.5">
                  <span className="inline-flex items-center justify-center size-4 rounded-full bg-black ring-1 ring-white/20 shrink-0">
                    <img
                      src="/logos/cursor.svg"
                      alt="Cursor"
                      className="size-2.5 brightness-0 invert"
                    />
                  </span>
                  <span
                    className="relative z-10 inline-flex items-center justify-center size-4 rounded-full ring-1 ring-background shrink-0"
                    style={{ backgroundColor: "#D97757" }}
                  >
                    <img
                      src="/logos/Claude Code.svg"
                      alt="Claude"
                      className="size-2.5 brightness-0 invert"
                    />
                  </span>
                </span>
                {t("virtualMcp.virtualMcp.connect")}
              </Button>
            </div>

            {/* Creator metadata */}
            <div className="flex items-center gap-2 -mt-6 text-sm text-muted-foreground">
              <User
                id={virtualMcp.created_by}
                size="2xs"
                className="text-sm text-muted-foreground"
              />
              <span className="text-muted-foreground/50">·</span>
              <span>
                {t("virtualMcp.virtualMcp.created")}{" "}
                {new Date(virtualMcp.created_at).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </span>
              <span className="text-muted-foreground/50">·</span>
              <span>
                {lastUsedAt
                  ? t("virtualMcp.virtualMcp.lastUsed", {
                      time: formatDistanceToNow(new Date(lastUsedAt), {
                        addSuffix: true,
                        locale,
                      }),
                    })
                  : t("virtualMcp.virtualMcp.neverUsed")}
              </span>
            </div>

            {/* Connections section */}
            <section className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-medium text-foreground">
                  {t("virtualMcp.virtualMcp.connections")}
                </h2>
                {connections.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleOpenAddDialog}
                  >
                    <Plus size={14} />
                    {t("virtualMcp.virtualMcp.addConnection")}
                  </Button>
                )}
              </div>
              <div className="flex flex-col gap-2">
                {connections.length === 0 ? (
                  <button
                    type="button"
                    onClick={handleOpenAddDialog}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-dashed border-border hover:bg-accent/50 transition-colors w-full text-left cursor-pointer"
                  >
                    <div className="flex items-center justify-center size-8 rounded-md text-muted-foreground/75 border border-dashed border-border shrink-0">
                      <Plus size={16} />
                    </div>
                    <span className="text-sm text-muted-foreground">
                      {t("virtualMcp.virtualMcp.noConnectionsYet")}
                    </span>
                  </button>
                ) : (
                  connections.map((conn) => (
                    <ErrorBoundary
                      key={conn.connection_id}
                      fallback={() => null}
                    >
                      <Suspense fallback={<ConnectionItemSkeleton />}>
                        <ConnectionItem
                          connection_id={conn.connection_id}
                          usedConnectionIds={addedConnectionIds}
                          onOpenSettings={() =>
                            handleOpenSettings(conn.connection_id)
                          }
                          onRemove={() =>
                            handleRemoveConnection(conn.connection_id)
                          }
                          onAuthenticate={handleAuthenticate}
                          onSwitchInstance={handleSwitchInstance}
                          onNewInstance={() =>
                            handleNewInstance(conn.connection_id)
                          }
                        />
                      </Suspense>
                    </ErrorBoundary>
                  ))
                )}
              </div>
            </section>

            {/* Instructions section */}
            <section className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-medium text-foreground">
                  {t("virtualMcp.virtualMcp.instructions")}
                </h2>
                <div className="flex items-center gap-2">
                  {!form.watch("metadata.instructions")?.trim() && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleInsertTemplate}
                    >
                      {t("virtualMcp.virtualMcp.promptTemplate")}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      isImproving ||
                      !form.watch("metadata.instructions")?.trim()
                    }
                    onClick={handleImprovePrompt}
                  >
                    <Stars01 size={13} />
                    {t("virtualMcp.virtualMcp.improve")}
                  </Button>
                </div>
              </div>
              <Controller
                name="metadata.instructions"
                control={form.control}
                render={({ field }) => (
                  <div className="relative rounded-xl card-shadow bg-card focus-within:ring-1 focus-within:ring-ring">
                    <Textarea
                      {...field}
                      value={field.value ?? ""}
                      onChange={(e) => {
                        field.onChange(e);
                      }}
                      onBlur={() => {
                        field.onBlur();
                        flushAndSave();
                      }}
                      placeholder={t(
                        "virtualMcp.virtualMcp.instructionsPlaceholder",
                      )}
                      className="min-h-[200px] max-h-[360px] overflow-auto resize-none text-base text-muted-foreground placeholder:text-muted-foreground/40 leading-relaxed border-0 shadow-none px-4 py-3 pr-11 focus-visible:ring-0 focus-visible:ring-offset-0 bg-transparent"
                      style={{ boxShadow: "none" }}
                    />
                    <Tooltip delayDuration={0}>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="absolute top-2 right-2 h-7 w-7 text-muted-foreground"
                          onClick={() => setInstructionsFullscreen(true)}
                          aria-label={t(
                            "virtualMcp.virtualMcp.openFullscreenEditor",
                          )}
                        >
                          <Maximize01 size={14} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="left">
                        {t("virtualMcp.virtualMcp.fullscreen")}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                )}
              />
            </section>

            {/* Files section — files attached to the agent as reference */}
            <FilesSection form={form} />

            {/* Sub-agents section — delegation allowlist for the subtask tool */}
            <ErrorBoundary fallback={() => null}>
              <Suspense
                fallback={
                  <section className="flex flex-col gap-3">
                    <h2 className="text-sm font-medium text-foreground">
                      {t("virtualMcp.virtualMcp.subAgents")}
                    </h2>
                    <div className="h-16 rounded-lg border border-dashed border-border animate-pulse" />
                  </section>
                }
              >
                <SubAgentsSection form={form} currentAgentId={virtualMcp.id} />
              </Suspense>
            </ErrorBoundary>

            {/* Layout section */}
            <LayoutTabContent
              virtualMcpId={virtualMcp.id}
              form={form}
              flushAndSave={flushAndSave}
            />

            {/* Development agent section (link a dev counterpart) */}
            <DevAgentSetup virtualMcp={virtualMcp} />

            {/* CMS section — Fast Preview + Publishing (how CMS/code changes
                reach the live site). Publishing is code-agent only. */}
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-medium text-foreground">
                  {t("sandbox.cmsSettings.title")}
                </h2>
              </div>
              <Card className="p-6 gap-5">
                {/* Preview — preview URL + the Fast Preview switch it gates
                    (a URL is required for Fast Preview to take effect). */}
                <CardContent className="p-0 space-y-5">
                  <div className="flex flex-col gap-1">
                    <h3 className="text-sm font-medium text-foreground">
                      {t("sandbox.cmsSettings.preview.title")}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      {t("sandbox.cmsSettings.preview.description")}
                    </p>
                  </div>
                  <PreviewServerUrlField control={form.control} />
                  <FastPreviewField
                    control={form.control}
                    previewServerUrl={form.watch("metadata.previewServerUrl")}
                  />
                </CardContent>

                {hasGithubRepo && (
                  <>
                    <div className="border-t border-border -mx-6" />
                    <CardContent className="p-0 space-y-5">
                      <div className="flex flex-col gap-1">
                        <h3 className="text-sm font-medium text-foreground">
                          {t("virtualMcp.virtualMcp.publishing")}
                        </h3>
                        <p className="text-sm text-muted-foreground">
                          {t("virtualMcp.virtualMcp.publishingDescription")}
                        </p>
                      </div>
                      <PublishPolicyField
                        control={form.control}
                        onCommit={flushAndSave}
                      />
                    </CardContent>
                  </>
                )}

                {/* Editing — content-editing preferences (auto-open the CMS,
                    team sync, compact field descriptions). */}
                <div className="border-t border-border -mx-6" />
                <CardContent className="p-0 space-y-5">
                  <div className="flex flex-col gap-1">
                    <h3 className="text-sm font-medium text-foreground">
                      {t("sandbox.cmsSettings.editing.title")}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      {t("sandbox.cmsSettings.editing.description")}
                    </p>
                  </div>
                  {hasClonableSource && (
                    <div className="flex items-center justify-between gap-4">
                      <div className="space-y-0.5 min-w-0">
                        <Label className="font-normal text-foreground">
                          {t("virtualMcp.layoutTabContent.openCms")}
                        </Label>
                        <p className="text-xs text-muted-foreground">
                          {t("virtualMcp.layoutTabContent.openCmsDescription")}
                        </p>
                      </div>
                      <Switch
                        className="shrink-0"
                        checked={cmsDefaultOpen}
                        onCheckedChange={(checked) => {
                          form.setValue(
                            "metadata.ui.layout",
                            { ...layoutMeta, cmsDefaultOpen: checked },
                            { shouldDirty: true },
                          );
                          flushAndSave();
                        }}
                      />
                    </div>
                  )}
                  {hasGithubRepo && (
                    <div className="flex items-center justify-between gap-4">
                      <div className="space-y-0.5 min-w-0">
                        <Label className="font-normal text-foreground">
                          {t("virtualMcp.virtualMcp.teamSync")}
                        </Label>
                        <p className="text-xs text-muted-foreground">
                          {t("virtualMcp.virtualMcp.teamSyncDescription")}
                        </p>
                      </div>
                      <Switch
                        className="shrink-0"
                        checked={
                          form.watch("metadata.syncButtonEnabled") ?? false
                        }
                        onCheckedChange={(checked) => {
                          form.setValue("metadata.syncButtonEnabled", checked, {
                            shouldDirty: true,
                          });
                          flushAndSave();
                        }}
                      />
                    </div>
                  )}
                  <FieldDescriptionTooltipsField control={form.control} />
                </CardContent>
              </Card>
            </div>

            {/* Sandbox section */}
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-medium text-foreground">
                  {t("virtualMcp.virtualMcp.sandbox")}
                </h2>
              </div>
              <Card className="p-6 gap-5">
                <CardContent className="p-0 space-y-5">
                  <RepoRow repo={runtimeCardRepo} />
                  <RuntimeFields control={form.control} />
                  <EnvVarsField
                    control={form.control}
                    form={form}
                    virtualMcpId={virtualMcp.id}
                    orgSlug={org.slug}
                  />
                  <SubmoduleCredentialsField
                    control={form.control}
                    form={form}
                  />
                </CardContent>
              </Card>
            </div>

            {/* Danger zone */}
            <section className="flex items-center justify-between border-t border-border pt-6">
              <div>
                <p className="text-sm font-medium">
                  {t("virtualMcp.virtualMcp.deleteAgent")}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t("virtualMcp.virtualMcp.deleteAgentDescription")}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="text-destructive border-destructive/40 hover:bg-destructive/10 hover:text-destructive shrink-0"
                onClick={() => setDeleteDialogOpen(true)}
              >
                <Trash01 size={14} />
                {t("virtualMcp.virtualMcp.deleteAgent")}
              </Button>
            </section>
          </div>
        </Page.Body>
      </Page.Content>

      {/* Dialogs */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("virtualMcp.virtualMcp.deleteAgentConfirm")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("virtualMcp.virtualMcp.deleteAgentConfirmDescription", {
                title: virtualMcp.title,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("virtualMcp.virtualMcp.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("virtualMcp.virtualMcp.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AddConnectionDialog
        open={dialogState.addDialogOpen}
        onOpenChange={(open) =>
          dispatch({ type: "SET_ADD_DIALOG_OPEN", payload: open })
        }
        agentId={virtualMcp.id}
        addedConnectionIds={addedConnectionIds}
        onAdd={handleAddConnection}
      />

      <DependencySelectionDialog
        open={dialogState.settingsDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            dispatch({ type: "CLOSE_SETTINGS" });
          }
        }}
        selectedId={dialogState.settingsConnectionId}
        form={form}
        connections={connections}
        onAuthenticate={handleAuthenticate}
      />

      <VirtualMCPShareModal
        open={dialogState.shareDialogOpen}
        onOpenChange={(open) =>
          dispatch({ type: "SET_SHARE_DIALOG_OPEN", payload: open })
        }
        virtualMcp={virtualMcp}
      />

      <Dialog
        open={instructionsFullscreen}
        onOpenChange={setInstructionsFullscreen}
      >
        <DialogContent className="w-[90vw] sm:max-w-6xl h-[85vh] flex flex-col p-0 gap-0">
          <DialogHeader className="px-6 pt-6 pb-3 border-b border-border shrink-0">
            <DialogTitle>{t("virtualMcp.virtualMcp.instructions")}</DialogTitle>
          </DialogHeader>
          <div className="flex-1 min-h-0 p-6">
            <Controller
              name="metadata.instructions"
              control={form.control}
              render={({ field }) => (
                <Textarea
                  {...field}
                  value={field.value ?? ""}
                  onChange={(e) => {
                    field.onChange(e);
                  }}
                  onBlur={() => {
                    field.onBlur();
                    flushAndSave();
                  }}
                  disabled={hasGithubRepo}
                  placeholder={t(
                    "virtualMcp.virtualMcp.instructionsPlaceholder",
                  )}
                  className="w-full h-full resize-none text-base text-muted-foreground placeholder:text-muted-foreground/40 leading-relaxed rounded-xl card-shadow px-4 py-3 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-0 bg-card border-0"
                  style={{ boxShadow: "none" }}
                />
              )}
            />
          </div>
        </DialogContent>
      </Dialog>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Exported view component (route-agnostic)
// ---------------------------------------------------------------------------

export function VirtualMcpDetailView({
  virtualMcpId,
  hideOwnTitle,
}: {
  virtualMcpId: string;
  hideOwnTitle?: boolean;
}) {
  const t = useT();
  const navigate = useNavigate();
  const { org } = useProjectContext();

  const virtualMcp = useVirtualMCP(virtualMcpId);
  if (!virtualMcp) {
    return (
      <div className="flex h-full w-full bg-background">
        <EmptyState
          title={t("virtualMcp.virtualMcp.spaceNotFound")}
          description={t("virtualMcp.virtualMcp.spaceNotFoundDescription")}
          actions={
            <Button
              variant="outline"
              onClick={() =>
                navigate({
                  to: "/$org",
                  params: { org: org.slug },
                })
              }
            >
              {t("virtualMcp.virtualMcp.backToSpaces")}
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <VirtualMcpDetailViewWithData
      key={getActiveGithubRepo(virtualMcp)?.connectionId ?? ""}
      virtualMcp={virtualMcp}
      hideOwnTitle={hideOwnTitle}
    />
  );
}
