/**
 * "Beber da fonte do Studio": antes de cada análise, o app descobre sozinho a
 * loja — domínio, slug do Deco Analytics e repositório — a partir do projeto
 * do site. Ninguém digita nada; o formulário do perfil virou só um override.
 *
 * Falha vira erro na lista `errors`, nunca derruba a análise: o perfil que já
 * existe continua valendo.
 */

import {
  pickStudioProject,
  type StudioProject,
  type VirtualMcpItem,
} from "./studio-project.ts";
import type { SiteSources } from "./types.ts";

const errorOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

export async function detectSiteSources(opts: {
  /** Os Virtual MCPs da org. */
  projects: () => Promise<readonly VirtualMcpItem[]>;
  orgSlug: string;
  /** Domínio já conhecido (perfil), pra escolher entre vários projetos. */
  domain: string | null;
  now: string;
}): Promise<{ sources: SiteSources; project: StudioProject | null }> {
  const errors: string[] = [];
  let project: StudioProject | null = null;
  try {
    project = pickStudioProject(await opts.projects(), {
      orgSlug: opts.orgSlug,
      domain: opts.domain,
    });
    if (!project) errors.push("nenhum projeto de site nesta org do Studio");
  } catch (err) {
    errors.push(`projeto do Studio: ${errorOf(err)}`);
  }

  return {
    project,
    sources: {
      detected_at: opts.now,
      studio_project: project
        ? {
            id: project.id,
            title: project.title,
            site_slug: project.site_slug,
            domain: project.domain,
            runtime: project.runtime,
          }
        : null,
      repository: project?.repository ?? null,
      errors,
    },
  };
}
