import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import type { VirtualMcpSidebarView } from "@decocms/shared/sdk/types";
import { format, formatDistanceToNow } from "date-fns";
import { generatePrefixedId } from "@decocms/shared/utils/generate-id";

import { useChatStream } from "@/components/chat/context";
import { buildImprovePromptDoc } from "@/components/chat/tiptap/build-improve-prompt-doc";
import { EmptyState } from "@/components/empty-state.tsx";
import { ErrorBoundary } from "@/components/error-boundary";
import { usePanelActions } from "@/layouts/shell-layout";
import { User } from "@/components/user/user";
import { useT } from "@/i18n/use-t.ts";
import { useDateFnsLocale } from "@/hooks/use-date-fns-locale.ts";

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
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import {
  ENV_VAR_KEY_RE,
  getWellKnownDecopilotVirtualMCP,
  useConnectionActions,
  useProjectContext,
  useVirtualMCP,
  useVirtualMCPActions,
  useVirtualMCPsLastUsed,
} from "@/sdk";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  LinkExternal01,
  Maximize01,
  Plus,
  Stars01,
  Trash01,
} from "@untitledui/icons";
import { Suspense, useEffect, useReducer, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useDebouncedAutosave } from "@/hooks/use-debounced-autosave.ts";
import { toast } from "sonner";
import { Page } from "@/components/page";
import { AddConnectionDialog } from "./add-connection-dialog";
import { track } from "@/lib/posthog-client";
import { DependencySelectionDialog } from "./dependency-selection-dialog";
import { ConnectionItem, ConnectionItemSkeleton } from "./connection-item";
import { ProjectViewsSection } from "./settings/views-section";
import { useProjectViews } from "./settings/use-project-views";
import { ProjectIdentity } from "./settings/project-identity";
import { ProjectSettingsTabs } from "./settings/settings-tabs";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsCardRow,
  SettingsPage,
  SettingsSection,
} from "@/components/settings/settings-section";
import { useProjectSettingsSection } from "./settings/use-settings-section";
import type { ProjectSettingsSectionKey } from "./settings/sections";
import { SiteTokenSection } from "./settings/site-token-section";
import { PreviewSettingsRows } from "./settings/preview-settings-rows";
import { useMainSchemaV8 } from "@/hooks/use-main-schema-v8";
import { ALL_ITEMS_SELECTED } from "./selection-utils";
import { VirtualMcpFormSchema, type VirtualMcpFormData } from "./types";
import { VirtualMCPShareModal } from "./virtual-mcp-share-modal";
import { getActiveRepository } from "@/lib/repository-binding";
import {
  agentHasClonableSource,
  agentHasConnectedRepository,
} from "@/lib/agent-capabilities";
import { EnvVarsField } from "@/components/sandbox/runtime-card/env-vars-field";
import { omitSandboxMap } from "@/lib/omit-sandbox-map";
import { RepositoryCard } from "./settings/repository-card";
import { RuntimeFields } from "@/components/sandbox/runtime-card/runtime-fields";
import { RuntimeAppsField } from "@/components/sandbox/runtime-card/runtime-apps-field";
import { useOrgFlag } from "@/hooks/use-organization-settings";
import { resolvePreviewServerUrl } from "@decocms/shared/deco-site-production-url";
import { FieldDescriptionTooltipsField } from "@/components/sandbox/runtime-card/field-description-tooltips-field";
import { PublishPolicyField } from "./publish-policy-field";
import { ContentEditingField } from "./content-editing-field";
import { resolveCmsMode } from "@decocms/shared/sdk/types";
import {
  initialProjectSidebarFormFields,
  isVirtualMcpCollectionQueryKey,
  optimisticProjectSidebarViewsNeedSave,
  projectSidebarFormFieldsForSave,
  readCachedVirtualMcp,
  useOptimisticProjectSidebarViewsActions,
  writeAuthoritativeVirtualMcpCaches,
} from "@/layouts/main-panel-tabs/optimistic-project-sidebar-views";
import {
  effectiveProjectSidebarViews,
  PROJECT_SIDEBAR_VIEWS_VERSION,
  resolveProjectSidebarViews,
} from "@/layouts/main-panel-tabs/project-sidebar-views";
import { runSerializedTask } from "@/lib/serial-task-queue";

type DialogState = {
  shareDialogOpen: boolean;
  addDialogOpen: boolean;
  settingsDialogOpen: boolean;
  settingsConnectionId: string | null;
};

interface AuthoritativeSidebarState {
  effectiveViews: VirtualMcpSidebarView[];
  rawViews: VirtualMcpSidebarView[] | null | undefined;
  version: typeof PROJECT_SIDEBAR_VIEWS_VERSION | undefined;
  /** The views offered once that this project has seen (saved with its list). */
  seen: VirtualMcpSidebarView[] | null | undefined;
}

function authoritativeSidebarState(
  virtualMcp: VirtualMCPEntity,
): AuthoritativeSidebarState {
  const rawViews = virtualMcp.metadata?.sidebarViews;
  const version = virtualMcp.metadata?.sidebarViewsVersion;
  return {
    effectiveViews: [
      ...effectiveProjectSidebarViews(
        resolveProjectSidebarViews(virtualMcp.metadata),
        version,
      ),
    ],
    rawViews: rawViews === null ? null : rawViews ? [...rawViews] : undefined,
    version,
    seen: virtualMcp.metadata?.sidebarViewsSeen ?? undefined,
  };
}

function sameRawSidebarViews(
  left: readonly VirtualMcpSidebarView[] | null | undefined,
  right: readonly VirtualMcpSidebarView[] | null | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((view, index) => view === right[index]);
}

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
  contextSection,
}: {
  virtualMcp: VirtualMCPEntity;
  contextSection: ProjectContextSection | null;
}) {
  const t = useT();
  const locale = useDateFnsLocale();
  const { org } = useProjectContext();
  const actions = useVirtualMCPActions();
  const { data: lastUsedMap } = useVirtualMCPsLastUsed([virtualMcp.id]);
  const lastUsedAt = lastUsedMap?.get(virtualMcp.id)?.last_used_at;
  const connectionActions = useConnectionActions();
  const queryClient = useQueryClient();
  const studio = useStudioTools();
  const optimisticSidebarViews = useOptimisticProjectSidebarViewsActions(
    virtualMcp.id,
  );
  const saveQueueKey = JSON.stringify([org.id, virtualMcp.id]);
  const initialSidebarFormFields = initialProjectSidebarFormFields(
    virtualMcp.metadata,
    optimisticSidebarViews.snapshot(),
  );

  // Form setup. Seed `metadata.previewServerUrl` through the dual-read
  // resolver so a project persisted under the legacy `productionUrl` key
  // shows its value — and migrates it to the new key on the next save.
  const form = useForm<VirtualMcpFormData>({
    resolver: zodResolver(VirtualMcpFormSchema),
    defaultValues: {
      ...virtualMcp,
      metadata: {
        ...omitSandboxMap(virtualMcp.metadata),
        previewServerUrl: resolvePreviewServerUrl(virtualMcp.metadata),
        ...initialSidebarFormFields,
      },
    },
  });

  // Watch connections for reactive UI
  const connections = form.watch("connections");
  const multiAppPreview = useOrgFlag("multi_app_preview");

  // GitHub repo connected (real auth) — instructions become read-only
  const hasRepository = agentHasConnectedRepository(virtualMcp);

  // Gates the Content editing block — same condition LayoutTabContent uses to
  // gate Preview/Content as a main-view option (a Start Website template or a
  // connected GitHub repo).
  const hasClonableSource = agentHasClonableSource(virtualMcp?.metadata);
  // No CMS for this agent — the rest of the CMS card configures one, so it
  // collapses to the control that turned it off. Needs the control on screen
  // (`hasClonableSource`) or an API-written mode would empty the card.
  const cmsOff =
    hasClonableSource &&
    resolveCmsMode(form.watch("metadata.ui.layout")) === "off";

  // Repo info for the Runtime card (display-only — loose check is intentional)
  const repositoryForRuntimeCard = getActiveRepository(virtualMcp);
  const runtimeCardRepo = repositoryForRuntimeCard
    ? {
        owner: repositoryForRuntimeCard.owner,
        name: repositoryForRuntimeCard.name,
        url: repositoryForRuntimeCard.url,
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
  const { openSidePanel } = usePanelActions();
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

      openSidePanel();

      // This chat runs as the agent being edited; agent CRUD is Super-Agent-only.
      const superAgent = getWellKnownDecopilotVirtualMCP(org.id);
      await sendMessage({
        tiptapDoc: buildImprovePromptDoc({
          managerAgentId: superAgent.id,
          managerName: superAgent.title,
          kind: "agent",
          id: virtualMcp.id,
          instructions: currentInstructions,
        }),
      });
    } finally {
      setIsImproving(false);
    }
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

  const persistForm = async () => {
    const optimisticSidebarViewsSnapshot = optimisticSidebarViews.snapshot();
    const virtualMcpQueryFilter = {
      predicate: (query: { queryKey: readonly unknown[] }) =>
        isVirtualMcpCollectionQueryKey(query.queryKey, org.id),
    };
    const refreshVirtualMcpCaches = async () => {
      await queryClient.invalidateQueries({
        predicate: (query) =>
          isVirtualMcpCollectionQueryKey(query.queryKey, org.id),
        // A route change can unmount the item observer while its trailing save
        // is completing. Failure recovery still needs an authoritative row.
        refetchType: "all",
      });
      return readCachedVirtualMcp(queryClient, org.id, virtualMcp.id);
    };
    const reconcileFormSidebar = (
      authoritative: AuthoritativeSidebarState | null,
      fallbackViews: readonly VirtualMcpSidebarView[] | null,
    ) => {
      if (authoritative) {
        if (
          !sameRawSidebarViews(
            form.getValues("metadata.sidebarViews"),
            authoritative.rawViews,
          )
        ) {
          form.setValue("metadata.sidebarViews", authoritative.rawViews, {
            shouldDirty: false,
          });
        }
        if (
          form.getValues("metadata.sidebarViewsVersion") !==
          authoritative.version
        ) {
          form.setValue("metadata.sidebarViewsVersion", authoritative.version, {
            shouldDirty: false,
          });
        }
        if (
          !sameRawSidebarViews(
            form.getValues("metadata.sidebarViewsSeen"),
            authoritative.seen,
          )
        ) {
          form.setValue("metadata.sidebarViewsSeen", authoritative.seen, {
            shouldDirty: false,
          });
        }
        return;
      }
      if (fallbackViews === null) return;
      // A failed refresh can still roll back to the last locally confirmed
      // effective selection. Marking it as v1 preserves those exact semantics.
      form.setValue("metadata.sidebarViews", [...fallbackViews], {
        shouldDirty: false,
      });
      form.setValue(
        "metadata.sidebarViewsVersion",
        PROJECT_SIDEBAR_VIEWS_VERSION,
        { shouldDirty: false },
      );
    };

    const sidebarNeedsSave = optimisticProjectSidebarViewsNeedSave(
      optimisticSidebarViewsSnapshot,
    );

    // form.formState is a Proxy over React state. When persistForm runs
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
    if (dirtyKeys.length === 0 && !sidebarNeedsSave) {
      // The optimistic revision returned to the last confirmed selection. It
      // can be removed without a request, but must never acknowledge a value
      // that merely matches an in-flight request's temporary RHF baseline.
      await optimisticSidebarViews.settle({
        snapshot: optimisticSidebarViewsSnapshot,
        saved: true,
        authoritativeViews: optimisticSidebarViewsSnapshot?.persistedViews,
      });
      return;
    }
    const savedFieldKeys = dirtyKeys.length > 0 ? dirtyKeys : ["metadata"];
    const instructionsDirty = savedFieldKeys.includes("metadata");

    const formData = form.getValues();
    // Rebase the dirty baseline to the snapshot we're about to send so that
    // an edit during the in-flight save that returns a value to its pre-save
    // default still registers as dirty. keepValues preserves the user's
    // current form values; only _defaultValues advances.
    form.reset(formData, { keepValues: true });

    // Strip in-progress env rows (no key, or kind=secret with no secretId).
    // They stay in form state so the user keeps editing, but the request body
    // only carries entries the server schema accepts.
    const payload = stripIncompleteEnvEntries(formData);
    const cachedVirtualMcp = readCachedVirtualMcp(
      queryClient,
      org.id,
      virtualMcp.id,
    );
    const sidebarFieldsForSave = projectSidebarFormFieldsForSave(
      {
        sidebarViews: payload.metadata?.sidebarViews,
        sidebarViewsVersion: payload.metadata?.sidebarViewsVersion,
      },
      optimisticSidebarViewsSnapshot,
      cachedVirtualMcp?.metadata,
    );
    payload.metadata = {
      ...omitSandboxMap(payload.metadata),
      ...sidebarFieldsForSave,
    };

    let savedVirtualMcp: VirtualMCPEntity;
    try {
      savedVirtualMcp = await actions.update.mutateAsync({
        id: virtualMcp.id,
        data: payload,
      });
    } catch (error) {
      let authoritativeVirtualMcp: VirtualMCPEntity | null = null;
      try {
        authoritativeVirtualMcp = await refreshVirtualMcpCaches();
      } catch {
        // Keep the last locally confirmed value when the read-back fails too.
      }
      const authoritative = authoritativeVirtualMcp
        ? authoritativeSidebarState(authoritativeVirtualMcp)
        : null;
      const settlement = await optimisticSidebarViews.settle({
        snapshot: optimisticSidebarViewsSnapshot,
        saved: false,
        authoritativeViews: authoritative?.effectiveViews,
      });
      if (settlement.settledLatest) {
        reconcileFormSidebar(authoritative, settlement.reconciledViews);
      }
      throw error;
    }

    // `useCollectionActions` starts one invalidation on success. Cancel that
    // potentially stale read and seed every active item/list cache from the
    // update response instead of starting a second invalidation.
    await queryClient.cancelQueries(virtualMcpQueryFilter);
    writeAuthoritativeVirtualMcpCaches(queryClient, org.id, savedVirtualMcp);
    const authoritative = authoritativeSidebarState(savedVirtualMcp);
    const settlement = await optimisticSidebarViews.settle({
      snapshot: optimisticSidebarViewsSnapshot,
      saved: true,
      authoritativeViews: authoritative.effectiveViews,
    });
    if (settlement.settledLatest) {
      reconcileFormSidebar(authoritative, settlement.reconciledViews);
    }

    // Accumulate into the current edit session and (re)schedule a flush
    // 30s after the last save.
    dispatchEditSession({
      type: "accumulate",
      now: Date.now(),
      fields: savedFieldKeys,
      instructionsLength: instructionsDirty
        ? (formData.metadata?.instructions?.length ?? 0)
        : null,
    });
    scheduleSessionFlush();
  };

  // Autosaves are full-record writes. Debouncing coalesces clicks that happen
  // before a request starts; this FIFO also prevents a slower older request
  // from completing after and overwriting a newer one.
  const saveForm = () => runSerializedTask(saveQueueKey, persistForm);

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
  const { section: settingsSection } = useProjectSettingsSection();
  /** In Context the menu picks the section; Instructions there is its own page. */
  const inContext = contextSection !== null;
  const section =
    contextSection === "instructions"
      ? null
      : (contextSection ?? settingsSection);
  const showGeneral = section === "general";
  const showInstructions = inContext
    ? contextSection === "instructions"
    : showGeneral;
  // Site tokens are for Blocks v8 sites only (hosted Deco CMS); a v7 site
  // never shows them.
  const hostedCms = useMainSchemaV8(virtualMcp.id) === "v8";
  const views = useProjectViews({
    virtualMcpId: virtualMcp.id,
    form,
    flushAndSave,
  });
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

  /** Right-hand summaries: what each row currently answers. */

  /** Connections owns its whole page, so its action rides in the page header;
   *  the instructions buttons sit beside their own heading inside General. */

  const connectButton = (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        track("agent_connect_modal_opened", { agent_id: virtualMcp.id });
        dispatch({ type: "SET_SHARE_DIALOG_OPEN", payload: true });
      }}
    >
      <LinkExternal01 size={14} />
      {t("virtualMcp.virtualMcp.connect")}
    </Button>
  );

  const sectionInstructionsActions = (
    <div className="flex items-center gap-2">
      {!form.watch("metadata.instructions")?.trim() && (
        <Button variant="outline" size="sm" onClick={handleInsertTemplate}>
          {t("virtualMcp.virtualMcp.promptTemplate")}
        </Button>
      )}
      <Button
        variant="outline"
        size="sm"
        disabled={isImproving || !form.watch("metadata.instructions")?.trim()}
        onClick={handleImprovePrompt}
      >
        <Stars01 size={13} />
        {t("virtualMcp.virtualMcp.improve")}
      </Button>
    </div>
  );

  return (
    <Page>
      <>
        {/* Context names the page and lists its sections in its own menu. */}
        {!inContext && (
          <>
            <Page.Title>{t("virtualMcp.settings.title")}</Page.Title>
            <ProjectSettingsTabs section={section ?? "general"} />
          </>
        )}
        <Page.Actions
          secondary={section === "connections" ? connectButton : undefined}
        >
          {section === "connections" ? (
            <Button size="sm" onClick={handleOpenAddDialog}>
              <Plus size={14} />
              {t("virtualMcp.virtualMcp.addConnection")}
            </Button>
          ) : section === "general" ? (
            connectButton
          ) : null}
        </Page.Actions>
        <Page.Content key={contextSection ?? section}>
          <Page.Container
            width="standard"
            className="@container/project-settings"
          >
            <SettingsPage>
              {/* Its own sections, so SettingsPage spaces them like every other
                pair rather than the tighter rhythm inside the identity block. */}
              {section === "views" && <ProjectViewsSection views={views} />}
              {showGeneral && (
                <ProjectIdentity form={form} onCommit={flushAndSave} />
              )}
              {section === "connections" && (
                <section className="flex flex-col gap-3">
                  <div className="flex flex-col gap-2">
                    {connections.length === 0 ? (
                      <button
                        type="button"
                        onClick={handleOpenAddDialog}
                        className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-dashed border-border hover:bg-accent transition-colors w-full text-left cursor-pointer"
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
              )}

              {/* Instructions section */}
              {showInstructions && (
                <section className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-sm font-medium text-foreground">
                      {t("virtualMcp.virtualMcp.instructions")}
                    </h2>
                    {sectionInstructionsActions}
                  </div>
                  <Controller
                    name="metadata.instructions"
                    control={form.control}
                    render={({ field }) => (
                      <div className="relative rounded-xl shadow-edge bg-card focus-within-ring">
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
                              size="icon-sm"
                              className="absolute top-2 right-2 text-muted-foreground"
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
              )}

              {section === "site" && !hasClonableSource && (
                <SettingsSection>
                  <SettingsCard>
                    <SettingsCardItem
                      title={t("virtualMcp.settings.cmsEmptyTitle")}
                      description={t("virtualMcp.settings.cmsEmpty")}
                      action={
                        <Button size="sm" variant="outline" asChild>
                          <Link to="." search={{ section: "repository" }}>
                            {t("virtualMcp.settings.repository.open")}
                          </Link>
                        </Button>
                      }
                    />
                  </SettingsCard>
                </SettingsSection>
              )}
              {/* CMS — content editing, then how changes reach the live
                site. Publishing is code-agent only. */}
              {section === "site" && hasClonableSource && (
                <SettingsSection title={t("sandbox.cmsSettings.title")}>
                  <SettingsCard>
                    <SettingsCardRow>
                      <ContentEditingField
                        control={form.control}
                        onCommit={flushAndSave}
                      />
                    </SettingsCardRow>
                    {/* Nothing to tune in the blocks form with the CMS off. */}
                    {!cmsOff && (
                      <SettingsCardRow>
                        <FieldDescriptionTooltipsField control={form.control} />
                      </SettingsCardRow>
                    )}
                    {!cmsOff && hasRepository && (
                      <SettingsCardRow>
                        <PublishPolicyField
                          control={form.control}
                          onCommit={flushAndSave}
                        />
                      </SettingsCardRow>
                    )}
                  </SettingsCard>
                </SettingsSection>
              )}

              {/* Preview — the URL, and the Fast Preview switch it gates
                (Fast Preview renders against that URL, so it needs one).
                Blocks v8 sites are always Fast Preview: no switch. */}
              {section === "site" && !cmsOff && (
                <SettingsSection
                  title={t("sandbox.cmsSettings.preview.title")}
                  description={t("sandbox.cmsSettings.preview.description")}
                >
                  <SettingsCard>
                    <PreviewSettingsRows
                      control={form.control}
                      isBlocksV8={hostedCms}
                      previewServerUrl={form.watch("metadata.previewServerUrl")}
                      fastPreview={form.watch("metadata.fastPreview")}
                    />
                  </SettingsCard>
                </SettingsSection>
              )}

              {/* Hosted Deco CMS (Blocks v8): the site's telemetry tokens. */}
              {section === "site" && hostedCms && hasRepository && (
                <SiteTokenSection
                  orgSlug={org.slug}
                  virtualMcpId={virtualMcp.id}
                />
              )}

              {/* Repository — which repo the project is, then how its
                sandbox runs it. */}
              {section === "repository" && (
                <RepositoryCard
                  repo={runtimeCardRepo}
                  onConnect={(binding) => {
                    form.setValue("metadata.repository", binding, {
                      shouldDirty: true,
                    });
                    return flushAndSave();
                  }}
                />
              )}
              {section === "repository" && (
                <SettingsSection
                  title={t("virtualMcp.settings.repository.runtimeTitle")}
                  description={t(
                    "virtualMcp.settings.repository.runtimeDescription",
                  )}
                >
                  <SettingsCard>
                    <SettingsCardRow>
                      <RuntimeFields control={form.control} />
                    </SettingsCardRow>
                    {multiAppPreview && (
                      <SettingsCardRow>
                        <RuntimeAppsField control={form.control} />
                      </SettingsCardRow>
                    )}
                    <SettingsCardRow>
                      <EnvVarsField
                        control={form.control}
                        form={form}
                        virtualMcpId={virtualMcp.id}
                        orgSlug={org.slug}
                        sandboxMap={virtualMcp.metadata.sandboxMap}
                      />
                    </SettingsCardRow>
                  </SettingsCard>
                </SettingsSection>
              )}
              {showGeneral && (
                <SettingsSection
                  title={t("virtualMcp.settings.groups.details")}
                >
                  <SettingsCard>
                    <SettingsCardItem
                      title={t("virtualMcp.virtualMcp.createdBy")}
                      action={
                        <User
                          id={virtualMcp.created_by}
                          size="2xs"
                          className="text-sm text-muted-foreground"
                        />
                      }
                    />
                    <SettingsCardItem
                      title={t("virtualMcp.virtualMcp.created")}
                      action={
                        <span className="text-sm text-muted-foreground">
                          {format(new Date(virtualMcp.created_at), "PP", {
                            locale,
                          })}
                        </span>
                      }
                    />
                    <SettingsCardItem
                      title={t("virtualMcp.virtualMcp.lastUsedLabel")}
                      action={
                        <span className="text-sm text-muted-foreground">
                          {lastUsedAt
                            ? formatDistanceToNow(new Date(lastUsedAt), {
                                addSuffix: true,
                                locale,
                              })
                            : t("virtualMcp.virtualMcp.neverUsed")}
                        </span>
                      }
                    />
                  </SettingsCard>
                </SettingsSection>
              )}
              {showGeneral && (
                <SettingsSection
                  title={t("virtualMcp.settings.groups.advanced")}
                >
                  <SettingsCard>
                    <SettingsCardItem
                      title={t("virtualMcp.virtualMcp.deleteAgent")}
                      description={t(
                        "virtualMcp.virtualMcp.deleteAgentDescription",
                      )}
                      action={
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => setDeleteDialogOpen(true)}
                        >
                          <Trash01 size={14} />
                          {t("virtualMcp.virtualMcp.deleteAgent")}
                        </Button>
                      }
                    />
                  </SettingsCard>
                </SettingsSection>
              )}
            </SettingsPage>
          </Page.Container>
        </Page.Content>
      </>

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
            <AlertDialogAction onClick={handleDelete} variant="destructive">
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
                  placeholder={t(
                    "virtualMcp.virtualMcp.instructionsPlaceholder",
                  )}
                  className="w-full h-full resize-none text-base text-muted-foreground placeholder:text-muted-foreground/40 leading-relaxed rounded-xl shadow-edge px-4 py-3 focus-ring bg-card border-0"
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

/** A section of the project's Context: settings plus Instructions on its own. */
export type ProjectContextSection = ProjectSettingsSectionKey | "instructions";

export function VirtualMcpDetailView({
  virtualMcpId,
  contextSection = null,
}: {
  virtualMcpId: string;
  /** Drawn as this section of the project's Context. */
  contextSection?: ProjectContextSection | null;
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
      // Re-seed the form on agent switch, not just on GitHub-repo change.
      key={`${virtualMcp.id}:${getActiveRepository(virtualMcp)?.connectionId ?? ""}`}
      virtualMcp={virtualMcp}
      contextSection={contextSection}
    />
  );
}
