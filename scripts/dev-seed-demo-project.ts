/**
 * Seed a local org with a COMPLETE demo project — every sidebar row a real
 * project has — using the real storage layer (no hand-written SQL).
 *
 * The rows are gated in two groups (`project-sidebar-views.ts`):
 *   - Home / Reports / Tasks / Site editor need a CLONABLE SOURCE, i.e.
 *     `metadata.githubRepo.url` (public-clone mode is enough for the rows).
 *   - Hosting / E2E / Deco Analytics / Monitor need the upstreams wired
 *     (CONTROLPLANE / ANALYTICS / CLICKHOUSE_ANALYTICS envs — see
 *     `scripts/dev-hosting-mock.ts` and `scripts/dev-monitor-seed.ts`), the
 *     project's `metadata.siteSlug`, and the org OWNING that slug in
 *     `org_sites` (else both BFFs answer 404 and the rows stay hidden).
 * Local mode passes the per-view rollout gate, so no org flag is needed here.
 *
 * Home and Tasks read the task board, so this also seeds a board: cards across
 * every canonical lane, attributed to the project through `task_board_items.repo`
 * (the one per-card project link), with tags, comments and activity.
 *
 * Run (from the repo root):
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:<port>/postgres \
 *   S3_ENDPOINT=http://127.0.0.1:<minio> \
 *   bun run scripts/dev-seed-demo-project.ts [--org=<slug|id>] [--slug=demo-store]
 *     [--title="Demo Store"] [--repo=deco-sites/storefront] [--no-board]
 *
 * Idempotent: re-running re-claims the slug, updates the existing project, and
 * replaces the cards it seeded (matched by their `dev-seed:` external keys).
 */

import { closeDatabase, createDatabase } from "../apps/api/src/database";
import { CredentialVault } from "../apps/api/src/encryption/credential-vault";
import { getSettings } from "../apps/api/src/settings";
import { OrgFileConfigStorage } from "../apps/api/src/storage/org-file-configs";
import { OrgSiteStorage } from "../apps/api/src/storage/org-sites";
import { TaskBoardStorage } from "../apps/api/src/storage/task-board";
import { TagStorage } from "../apps/api/src/storage/tags";
import { VirtualMCPStorage } from "../apps/api/src/storage/virtual";
import { resolveSeedOrg } from "./dev-seed-org";
import { isValidSiteSlug } from "../packages/shared/src/site-slug";
import type {
  TaskBoardItemPriority,
  TaskBoardItemType,
} from "../packages/shared/src/entities";

const args = new Map(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v = "true"] = a.slice(2).split("=");
      return [k, v] as const;
    }),
);

const SITE_SLUG = (args.get("slug") ?? "demo-store").toLowerCase();
const TITLE = args.get("title") ?? "Demo Store";
const ORG_REF = args.get("org");
const REPO = args.get("repo") ?? "deco-sites/storefront";
const SEED_BOARD = args.get("no-board") !== "true";
/** Dev MinIO, for the Assets row. Its port is per-boot — read it off the
 *  running server's `S3_ENDPOINT`, or pass `--s3-endpoint=`. */
const S3_ENDPOINT = args.get("s3-endpoint") ?? process.env.S3_ENDPOINT ?? "";
const S3_ACCESS_KEY =
  args.get("s3-access-key") ?? process.env.S3_ACCESS_KEY_ID ?? "minioadmin";
const S3_SECRET_KEY =
  args.get("s3-secret-key") ?? process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin";
/** The dev stack's own bucket — already created by `ensure-services`, so this
 *  script never has to make one (and needs no S3 SDK to try). */
const S3_BUCKET =
  args.get("s3-bucket") ?? process.env.S3_BUCKET ?? "studio-dev";

/** Every project row, in sidebar order. */
const SIDEBAR_VIEWS = [
  "overview",
  "reports",
  "board",
  "site-editor",
  "assets",
  "hosting",
  "e2e",
  "analytics",
  "cdn",
  "automations",
] as const;

/** Prefix of the `external_key` this script owns, so a re-run replaces its own
 *  cards and never a human's. */
const SEED_KEY_PREFIX = "dev-seed:";

interface SeedCard {
  key: string;
  title: string;
  description: string;
  status: string;
  priority: TaskBoardItemPriority;
  type: TaskBoardItemType;
  tags: string[];
  assign?: boolean;
  dueInDays?: number;
  comments?: string[];
}

const CARDS: SeedCard[] = [
  {
    key: "lcp-pdp",
    title: "PDP mobile LCP acima de 4s no iPhone",
    description:
      "O E2E de funil mede LCP 4.8s no mobile em /tenis-corrida/nimbus-26. A imagem principal do buybox entra sem `priority` e o carrossel hidrata antes dela.",
    status: "in_progress",
    priority: "urgent",
    type: "bug",
    tags: ["performance", "pdp"],
    assign: true,
    comments: [
      "Reproduzi no BrowserStack: iPhone 15, 4G. LCP 4.7s, CLS 0.28.",
      "O culpado é o preload do carrossel. Vou trocar a ordem e medir de novo.",
    ],
  },
  {
    key: "cart-500",
    title: "POST /api/cart devolve 500 em ~2% das sessões",
    description:
      "Aparece no console dos runs de E2E e nos erros do Deco Analytics. O minicart não monta e o funil trava em add_to_cart.",
    status: "in_review",
    priority: "urgent",
    type: "bug",
    tags: ["checkout", "api"],
    assign: true,
    comments: [
      "PR aberto. Falta decidir se o retry fica no client ou no loader.",
    ],
  },
  {
    key: "cache-institucional",
    title: "Páginas institucionais sem cache na borda",
    description:
      "Monitor mostra 31% de miss em /institucional/*. Faltou `cache-control` no loader; são páginas estáticas.",
    status: "todo",
    priority: "high",
    type: "chore",
    tags: ["performance", "infra"],
    dueInDays: 3,
  },
  {
    key: "redirect-trocas",
    title: "Redirect de /institucional/trocas está 404 no sitemap",
    description:
      "O redirect existe no control-plane, mas o sitemap ainda publica a URL antiga.",
    status: "todo",
    priority: "medium",
    type: "chore",
    tags: ["seo"],
  },
  {
    key: "busca-vazia",
    title: "Busca por termo com acento devolve vazio",
    description:
      "`/busca?q=tênis` não normaliza o termo antes de chamar a API de busca. Aparece em 4% das buscas do Analytics.",
    status: "triage",
    priority: "high",
    type: "bug",
    tags: ["busca"],
  },
  {
    key: "frete-banner",
    title: "Banner de frete grátis por região",
    description:
      "Mostrar a régua de frete grátis na home usando a região do visitante. Pedido do time de marketing para a coleção de verão.",
    status: "triage",
    priority: "medium",
    type: "feature",
    tags: ["marketing", "home"],
  },
  {
    key: "experimento-buybox",
    title: "Rodar experimento de buybox sticky no mobile",
    description:
      "Variante já está no ar para 50%. Precisa de 2 semanas de dados antes de decidir.",
    status: "triage",
    priority: "low",
    type: "spike",
    tags: ["experimentos", "pdp"],
  },
  {
    key: "webp-catalogo",
    title: "Converter imagens do catálogo para WebP",
    description:
      "Banda no Monitor está em 9.3 GB/semana, com 62% em JPEG do catálogo antigo.",
    status: "approved",
    priority: "medium",
    type: "chore",
    tags: ["performance", "assets"],
  },
  {
    key: "csp-headers",
    title: "Adicionar CSP e HSTS nos headers da borda",
    description:
      "Sem CSP hoje. Começar em report-only por uma semana, depois enforce.",
    status: "merged",
    priority: "high",
    type: "security",
    tags: ["seguranca", "infra"],
  },
  {
    key: "vtex-intent",
    title: "Intent de checkout VTEX perdendo o carrinho no Safari",
    description:
      "Cookie de orderForm com SameSite errado. Corrigido, aguardando validação em produção.",
    status: "post_deploy_validation",
    priority: "urgent",
    type: "bug",
    tags: ["checkout"],
    assign: true,
  },
  {
    key: "ga4-events",
    title: "Padronizar eventos GA4 do funil",
    description:
      "view_item, add_to_cart e begin_checkout estavam com nomes divergentes entre home e PDP.",
    status: "done",
    priority: "medium",
    type: "chore",
    tags: ["analytics"],
  },
  {
    key: "sitemap-split",
    title: "Quebrar sitemap em índices por categoria",
    description: "Sitemap único passou de 50k URLs e o Google truncava.",
    status: "done",
    priority: "low",
    type: "chore",
    tags: ["seo"],
  },
  {
    key: "legacy-newsletter",
    title: "Remover integração antiga de newsletter",
    description: "Substituída pelo provedor novo em julho.",
    status: "archived",
    priority: "none",
    type: "chore",
    tags: ["debito-tecnico"],
  },
];

const TAG_COLORS: Record<string, string> = {
  performance: "#f97316",
  pdp: "#8b5cf6",
  checkout: "#ef4444",
  api: "#0ea5e9",
  infra: "#64748b",
  seo: "#22c55e",
  busca: "#eab308",
  marketing: "#ec4899",
  home: "#14b8a6",
  experimentos: "#a855f7",
  assets: "#06b6d4",
  seguranca: "#dc2626",
  analytics: "#3b82f6",
  "debito-tecnico": "#78716c",
};

/** Files the assets bucket starts with, so the picker isn't empty. */
const ASSET_FILES: ReadonlyArray<[string, string]> = [
  ["banners/verao-2026-desktop.svg", "Verão 2026 — desktop"],
  ["banners/verao-2026-mobile.svg", "Verão 2026 — mobile"],
  ["produtos/nimbus-26-frente.svg", "Nimbus 26 — frente"],
  ["produtos/nimbus-26-lateral.svg", "Nimbus 26 — lateral"],
  ["produtos/dry-fit-preta.svg", "Dry fit preta"],
  ["institucional/tabela-de-medidas.svg", "Tabela de medidas"],
];

function placeholderSvg(label: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675">
  <rect width="1200" height="675" fill="#ededec"/>
  <rect x="48" y="48" width="1104" height="579" rx="16" fill="#e0e0de"/>
  <text x="600" y="345" font-family="ui-sans-serif,system-ui" font-size="42" fill="#8a8a86" text-anchor="middle">${label}</text>
</svg>`;
}

/**
 * The Assets row appears when a file config owns the site slug — by `site_slug`
 * (managed tenancy, which needs AWS STS) or by bucket name. So local dev gets a
 * `static` config on the dev MinIO bucket under a `<slug>/` prefix: the row
 * shows AND uploads/listing actually work.
 */
async function seedAssetsConfig(
  db: ReturnType<typeof createDatabase>["db"],
  organizationId: string,
  userId: string,
): Promise<void> {
  const prefix = `${SITE_SLUG}/`;
  const s3 = new Bun.S3Client({
    endpoint: S3_ENDPOINT,
    bucket: S3_BUCKET,
    region: "us-east-1",
    accessKeyId: S3_ACCESS_KEY,
    secretAccessKey: S3_SECRET_KEY,
    virtualHostedStyle: false,
  });

  try {
    for (const [key, label] of ASSET_FILES) {
      await s3.write(`${prefix}${key}`, placeholderSvg(label), {
        type: "image/svg+xml",
      });
    }
  } catch (err) {
    console.warn(
      `assets: could not reach S3 at ${S3_ENDPOINT} (${(err as Error).message}); skipping`,
    );
    return;
  }

  const configs = new OrgFileConfigStorage(
    db,
    new CredentialVault(getSettings().encryptionKey),
  );
  const name = `deco-assets-${SITE_SLUG}`;
  const existing = (await configs.list(organizationId)).find(
    (c) => c.name.toLowerCase() === name.toLowerCase(),
  );
  const storage = {
    bucket: S3_BUCKET,
    region: "us-east-1",
    endpoint: S3_ENDPOINT,
    forcePathStyle: true,
    prefix,
    publicUrlBase: `${S3_ENDPOINT}/${S3_BUCKET}/${SITE_SLUG}`,
    refreshUrl: null,
    siteSlug: SITE_SLUG,
    credentials: {
      type: "static" as const,
      accessKeyId: S3_ACCESS_KEY,
      secretAccessKey: S3_SECRET_KEY,
    },
  };

  if (existing) {
    await configs.update({
      id: existing.id,
      organizationId,
      ...storage,
      updatedBy: userId,
    });
    console.log(
      `assets: updated file config "${name}" → ${S3_ENDPOINT}/${S3_BUCKET}/${prefix}`,
    );
    return;
  }
  await configs.create({
    organizationId,
    name,
    description: `Local MinIO assets for the ${SITE_SLUG} demo site.`,
    ...storage,
    createdBy: userId,
  });
  console.log(
    `assets: created file config "${name}" → ${S3_ENDPOINT}/${S3_BUCKET}/${prefix}`,
  );
}

async function main() {
  if (!isValidSiteSlug(SITE_SLUG)) {
    throw new Error(`invalid site slug: ${SITE_SLUG}`);
  }
  const [repoOwner, repoName] = REPO.split("/");
  if (!repoOwner || !repoName) {
    throw new Error(`--repo must be "owner/name" (got "${REPO}")`);
  }

  const database = createDatabase(process.env.DATABASE_URL);
  const db = database.db;

  const org = await resolveSeedOrg(db, ORG_REF);
  const owner = org.owner;

  console.log(`org: ${org.name} (${org.slug}) — owner ${owner.email}`);

  const orgSites = new OrgSiteStorage(db);
  const claimed = await orgSites.claimSite({
    slug: SITE_SLUG,
    organizationId: org.id,
    source: "dev-seed",
    by: owner.id,
  });
  console.log(`org_sites: claimed "${claimed.slug}"`);

  /** The project is a VIRTUAL connection. `githubRepo` without an installation
   *  is public-clone mode — enough for the source-backed rows. */
  const metadata = {
    siteSlug: SITE_SLUG,
    githubRepo: {
      url: `https://github.com/${REPO}`,
      owner: repoOwner,
      name: repoName,
    },
    sidebarViews: [...SIDEBAR_VIEWS],
    sidebarViewsVersion: 1 as const,
    previewServerUrl: `https://www.${SITE_SLUG}.com.br`,
    instructions: `You are the agent for the ${TITLE} storefront (site slug \`${SITE_SLUG}\`, repo \`${REPO}\`).`,
  };

  const virtualMcps = new VirtualMCPStorage(db);
  const existing = await db
    .selectFrom("connections")
    .select(["id", "title"])
    .where("organization_id", "=", org.id)
    .where("connection_type", "=", "VIRTUAL")
    .where("title", "=", TITLE)
    .executeTakeFirst();

  const project = existing
    ? await virtualMcps.update(existing.id, owner.id, { metadata })
    : await virtualMcps.create(org.id, owner.id, {
        title: TITLE,
        description: `Storefront project wired to the ${SITE_SLUG} site (hosting, e2e, analytics, monitor).`,
        icon: "icon://Globe01?color=emerald",
        status: "active",
        pinned: false,
        metadata,
        connections: [],
      });

  console.log(
    `${existing ? "updated" : "created"} project: ${project.title} (${project.id}) → ${REPO}`,
  );

  if (S3_ENDPOINT) {
    await seedAssetsConfig(db, org.id, owner.id);
  }

  if (SEED_BOARD) {
    const board = new TaskBoardStorage(db);
    const tags = new TagStorage(db);

    const previous = await db
      .selectFrom("task_board_items")
      .select("id")
      .where("organization_id", "=", org.id)
      .where("external_key", "like", `${SEED_KEY_PREFIX}%`)
      .execute();
    for (const row of previous) {
      await board.delete(row.id, org.id, owner.id);
    }
    if (previous.length > 0) {
      console.log(
        `task board: removed ${previous.length} previously seeded cards`,
      );
    }

    const tagIds = new Map<string, string>();
    for (const name of new Set(CARDS.flatMap((c) => c.tags))) {
      const tag = await tags.createTag(org.id, name, TAG_COLORS[name] ?? null);
      tagIds.set(name, tag.id);
    }

    for (const card of CARDS) {
      const item = await board.create({
        organizationId: org.id,
        title: card.title,
        description: card.description,
        status: card.status,
        priority: card.priority,
        type: card.type,
        assigneeId: card.assign ? owner.id : null,
        assignedBy: card.assign ? owner.id : null,
        repo: REPO,
        dueDate:
          card.dueInDays == null
            ? null
            : new Date(Date.now() + card.dueInDays * 86_400_000).toISOString(),
        externalKey: `${SEED_KEY_PREFIX}${card.key}`,
        by: owner.id,
      });

      await board.setItemTags(
        item.id,
        card.tags.map((t) => tagIds.get(t)!).filter(Boolean),
        owner.id,
      );
      await board.recordActivity({
        taskBoardItemId: item.id,
        action: "created",
        actorId: owner.id,
      });
      for (const body of card.comments ?? []) {
        await board.createComment({
          taskBoardItemId: item.id,
          organizationId: org.id,
          authorId: owner.id,
          body,
        });
      }
    }
    console.log(
      `task board: seeded ${CARDS.length} cards across ${
        new Set(CARDS.map((c) => c.status)).size
      } lanes, ${tagIds.size} tags`,
    );
  }

  const base = `/${org.slug}/agents`;
  console.log(
    `\nopen (each row is a panel on the same project):\n` +
      [
        "overview",
        "reports",
        "board",
        "site-editor",
        "hosting",
        "e2e",
        "analytics",
        "cdn",
      ]
        .map((view) => `  ${base}/${view}?virtualmcpid=${project.id}`)
        .join("\n"),
  );

  await closeDatabase(database);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
