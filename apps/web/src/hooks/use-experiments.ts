/**
 * Experiments Hooks — per-site A/B experiment metadata, over the typed
 * studio-tools client (EXPERIMENT_* built-in tools).
 */

import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import type { StudioToolOutput } from "@decocms/shared/tools/tool-io";
import { useProjectContext } from "@/sdk";
import { KEYS } from "../lib/query-keys";
import { useStudioTools } from "../lib/studio-tools";

export type Experiment =
  StudioToolOutput<"EXPERIMENT_LIST">["experiments"][number];
export type ExperimentStatus = Experiment["status"];
export type ExperimentVariant = Experiment["variants"][number];
type StudioTools = ReturnType<typeof useStudioTools>;

export interface CreateExperimentInput {
  key: string;
  name: string;
  goals?: string[];
  variants?: ExperimentVariant[];
}

export interface UpdateExperimentInput {
  key: string;
  name?: string;
  status?: ExperimentStatus;
  goals?: string[];
  variants?: ExperimentVariant[];
}

/** One site's experiment list as a query, so a view reading many sites at once
 *  (the org Monitor) shares the cache with {@link useExperiments}. */
export function experimentsQuery(
  locator: Parameters<typeof KEYS.experiments>[0],
  studio: StudioTools,
  site: string,
) {
  return queryOptions({
    queryKey: KEYS.experiments(locator, site),
    queryFn: async () => {
      const { experiments } = await studio.call("EXPERIMENT_LIST", { site });
      return experiments;
    },
    enabled: !!site,
    staleTime: 30_000,
  });
}

export function useExperiments(site: string) {
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  return useQuery(experimentsQuery(locator, studio, site));
}

/** LOCAL DEV ONLY — writes a draft's manifest entry to a local site's
 *  `.deco/TestesAB.json`, so its dev server can preview it via `?__ab=`
 *  before anything is created. No-ops server-side (returns `synced: false`)
 *  unless the API is run with `AB_TESTING_LOCAL_MANIFEST_PATH` set. */
export function useSyncExperimentPreviewLocal(site: string) {
  const studio = useStudioTools();
  return useMutation({
    mutationFn: async (input: {
      key: string;
      variants: { id: string; weight: number }[];
    }) => {
      return await studio.call("EXPERIMENT_PREVIEW_SYNC_LOCAL", {
        site,
        ...input,
      });
    },
  });
}

/** LOCAL DEV ONLY — appends the arms to the local site's stylesheet as rules
 *  scoped by the SDK's `data-ab-<key>` root attribute, right in the create
 *  flow. No-ops (`implemented: false`) unless the API is run with
 *  `AB_TESTING_LOCAL_SITE_PATH` set, or when the arms need more than CSS. */
export function useImplementExperimentLocal(site: string) {
  const studio = useStudioTools();
  return useMutation({
    mutationFn: async (input: {
      key: string;
      variants: {
        id: string;
        role?: "control" | "treatment" | null;
        description?: string | null;
      }[];
    }) => {
      return await studio.call("EXPERIMENT_IMPLEMENT_LOCAL", {
        site,
        ...input,
      });
    },
    onSuccess: (result) => {
      if (result.implemented) {
        toast.success(`Wired into ${result.cssFile} locally.`);
      } else {
        toast.warning(
          `Didn't implement it automatically (${result.reason ?? "unknown reason"}) — the experiment was still created.`,
        );
      }
    },
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to implement this experiment locally",
      ),
  });
}

export function useCreateExperiment(site: string) {
  const queryClient = useQueryClient();
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  return useMutation({
    mutationFn: async (input: CreateExperimentInput) => {
      const { experiment } = await studio.call("EXPERIMENT_CREATE", {
        site,
        ...input,
      });
      return experiment;
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: KEYS.experiments(locator, site),
      }),
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : "Failed to create experiment",
      ),
  });
}

export type SuggestedExperiment = StudioToolOutput<"EXPERIMENT_SUGGEST">;

/** Turns a plain-language prompt into a proposed experiment (key, name,
 *  hypothesis, variants) — read-only, nothing is persisted until the caller
 *  reviews the result and calls `useCreateExperiment`. */
export function useSuggestExperiment(site: string) {
  const studio = useStudioTools();
  return useMutation({
    mutationFn: async (prompt: string) => {
      return await studio.call("EXPERIMENT_SUGGEST", { site, prompt });
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : "Failed to suggest experiment",
      ),
  });
}

/** Delegates the frontend implementation to the Super Agent, which opens a PR.
 *
 *  `openCard` picks what happens next: the explicit menu action jumps to the
 *  card's chat, while the create flow stays on the experiment it just made —
 *  yanking the operator to the board mid-create loses the thing they built. */
export function useImplementExperiment(
  site: string,
  { openCard = true }: { openCard?: boolean } = {},
) {
  const studio = useStudioTools();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { org, locator } = useProjectContext();
  return useMutation({
    mutationFn: async (key: string) => {
      return await studio.call("EXPERIMENT_IMPLEMENT", { site, key });
    },
    onSuccess: (result) => {
      // The experiment now points at a card; the detail screen follows its PR.
      queryClient.invalidateQueries({
        queryKey: KEYS.experiments(locator, site),
      });
      // A board list cached before this card would drop its key as stale.
      queryClient.invalidateQueries({
        queryKey: KEYS.taskBoardItems(locator),
      });
      // No key means no card address to open — say where it went instead.
      if (!openCard || !result.taskKey) {
        toast.success(
          "Sent to the Super Agent — it's writing the code and will open a PR.",
        );
        return;
      }
      navigate({
        to: "/$org/tasks/{-$taskKey}",
        params: { org: org.slug, taskKey: result.taskKey },
      });
    },
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to start implementing this experiment",
      ),
  });
}

/**
 * The whole "describe it and get a pull request" path in one call: create the
 * experiment, then delegate its frontend to the Super Agent.
 *
 * Sequential, not parallel: `EXPERIMENT_IMPLEMENT` reads the experiment row the
 * create writes. Delegation failing (no linked repository, quota) does NOT fail
 * the call — the experiment exists either way, and the screen it lands on is
 * where that state is explained.
 */
export function useCreateAndImplementExperiment(site: string) {
  const create = useCreateExperiment(site);
  const implement = useImplementExperiment(site, { openCard: false });
  return useMutation({
    mutationFn: async (input: CreateExperimentInput) => {
      const experiment = await create.mutateAsync(input);
      await implement.mutateAsync(experiment.key).catch(() => {});
      return experiment;
    },
  });
}

export function useUpdateExperiment(site: string) {
  const queryClient = useQueryClient();
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  return useMutation({
    mutationFn: async (input: UpdateExperimentInput) => {
      const { experiment } = await studio.call("EXPERIMENT_UPDATE", {
        site,
        ...input,
      });
      return experiment;
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: KEYS.experiments(locator, site),
      }),
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : "Failed to update experiment",
      ),
  });
}

export type ExperimentResults = NonNullable<
  StudioToolOutput<"EXPERIMENT_RESULTS">["results"]
>;

/** A/B results for one experiment, from analytics. `data.available` is false on
 *  deployments without the analytics backend wired (e.g. local dev). */
export function useExperimentResults(site: string, key: string) {
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  return useQuery({
    queryKey: KEYS.experimentResults(locator, site, key),
    queryFn: async () => {
      const res = await studio.call("EXPERIMENT_RESULTS", { site, key });
      return res;
    },
    enabled: !!site && !!key,
    staleTime: 60_000,
  });
}

export function useDeleteExperiment(site: string) {
  const queryClient = useQueryClient();
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  return useMutation({
    mutationFn: async (key: string) => {
      await studio.call("EXPERIMENT_DELETE", { site, key });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: KEYS.experiments(locator, site),
      }),
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : "Failed to delete experiment",
      ),
  });
}
