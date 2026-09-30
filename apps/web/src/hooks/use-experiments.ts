/**
 * Experiments Hooks — per-site A/B experiment metadata, over the typed
 * studio-tools client (EXPERIMENT_* built-in tools).
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { StudioToolOutput } from "@decocms/shared/tools/tool-io";
import { useProjectContext } from "@/sdk";
import { KEYS } from "../lib/query-keys";
import { useStudioTools } from "../lib/studio-tools";

export type Experiment =
  StudioToolOutput<"EXPERIMENT_LIST">["experiments"][number];
export type ExperimentStatus = Experiment["status"];
export type ExperimentVariant = Experiment["variants"][number];

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

export function useExperiments(site: string) {
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  return useQuery({
    queryKey: KEYS.experiments(locator, site),
    queryFn: async () => {
      const { experiments } = await studio.call("EXPERIMENT_LIST", { site });
      return experiments;
    },
    enabled: !!site,
    staleTime: 30_000,
  });
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

/** LOCAL DEV ONLY — writes the hook + gate directly into the local site's
 *  source, right in the create flow. No-ops (`implemented: false`) unless
 *  the API is run with `AB_TESTING_LOCAL_SITE_PATH` set. */
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
        toast.success(`Wired into ${result.targetFile} locally.`);
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

/** Delegates an already-created experiment's frontend implementation to the
 *  Super Agent (finds the affected component, wires `useExperiment(key)` in,
 *  opens a PR). Requires an explicit call — never triggered by
 *  `useCreateExperiment` itself. */
export function useImplementExperiment(site: string) {
  const studio = useStudioTools();
  return useMutation({
    mutationFn: async (key: string) => {
      return await studio.call("EXPERIMENT_IMPLEMENT", { site, key });
    },
    onSuccess: () =>
      toast.success(
        "Sent to the Super Agent — check the task board for progress.",
      ),
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to start implementing this experiment",
      ),
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
