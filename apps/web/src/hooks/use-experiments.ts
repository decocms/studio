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
