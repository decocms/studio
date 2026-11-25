import { type Kysely, sql } from "kysely";

/**
 * The store-analysis engine behind the Plan page, built into Studio
 * (storage in `src/storage/plan-engine*.ts`). Every row belongs to one
 * organization and goes with it.
 *
 * Ids of diagnoses, opportunities, hypotheses, knowledge and cost events stay
 * global primary keys: the engine derives child ids from the diagnosis id
 * (`<diagnosis>:o1`, `<opportunity>:h1`) and its writes refuse an id another
 * organization already holds.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("plan_ux_site_profiles")
    .addColumn("organization_id", "text", (col) =>
      col.primaryKey().references("organization.id").onDelete("cascade"),
    )
    .addColumn("domain", "text", (col) => col.notNull())
    .addColumn("studio_site", "text")
    .addColumn("pdp_path_template", "text", (col) =>
      col.notNull().defaultTo("/:product/p"),
    )
    .addColumn("competitors", "jsonb", (col) =>
      col.notNull().defaultTo(sql`'[]'::jsonb`),
    )
    .addColumn("competitors_confirmed_at", "timestamptz")
    .addColumn("design_system", "jsonb")
    .addColumn("design_system_at", "timestamptz")
    .addColumn("sources", "jsonb")
    .addColumn("code_tokens", "jsonb")
    .addColumn("code_repo", "text")
    .addColumn("code_project_id", "text")
    .addColumn("code_volume", "text")
    .addColumn("page_templates", "jsonb")
    .addColumn("updated_at", "timestamptz", (col) => col.notNull())
    .execute();

  await db.schema
    .createTable("plan_ux_diagnoses")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    // Breaks ties between runs started in the same millisecond.
    .addColumn("seq", "bigint", (col) => col.generatedAlwaysAsIdentity())
    .addColumn("page_type", "text", (col) => col.notNull().defaultTo("pdp"))
    .addColumn("status", "text", (col) => col.notNull().defaultTo("running"))
    .addColumn("stage", "text", (col) => col.notNull().defaultTo("queued"))
    .addColumn("progress_note", "text")
    .addColumn("domain", "text", (col) => col.notNull())
    .addColumn("summary", "jsonb")
    .addColumn("evidence", "jsonb")
    .addColumn("error", "text")
    .addColumn("cost_usd", "double precision")
    .addColumn("started_at", "timestamptz", (col) => col.notNull())
    .addColumn("finished_at", "timestamptz")
    .addColumn("restarted_at", "timestamptz")
    .addColumn("site_run_id", "text")
    .addColumn("goal_id", "text")
    .addColumn("objective_statement", "text")
    .addCheckConstraint(
      "plan_ux_diagnoses_status",
      sql`status IN ('running', 'done', 'error')`,
    )
    .execute();

  await db.schema
    .createIndex("plan_ux_diagnoses_org_started")
    .on("plan_ux_diagnoses")
    .columns(["organization_id", "started_at desc"])
    .execute();
  await db.schema
    .createIndex("plan_ux_diagnoses_org_page_status")
    .on("plan_ux_diagnoses")
    .columns(["organization_id", "page_type", "status"])
    .execute();
  await db.schema
    .createIndex("plan_ux_diagnoses_org_site_run")
    .on("plan_ux_diagnoses")
    .columns(["organization_id", "site_run_id"])
    .execute();
  await db.schema
    .createIndex("plan_ux_diagnoses_org_goal")
    .on("plan_ux_diagnoses")
    .columns(["organization_id", "goal_id", "started_at desc"])
    .execute();
  // A second concurrent start or re-verification of the same page loses here.
  await db.schema
    .createIndex("plan_ux_diagnoses_one_running")
    .on("plan_ux_diagnoses")
    .columns(["organization_id", "page_type"])
    .unique()
    .where(sql.ref("status"), "=", "running")
    .execute();

  await db.schema
    .createTable("plan_ux_opportunities")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("diagnosis_id", "text", (col) =>
      col.notNull().references("plan_ux_diagnoses.id").onDelete("cascade"),
    )
    .addColumn("rank", "integer", (col) => col.notNull())
    .addColumn("area", "text", (col) => col.notNull().defaultTo("pagina_geral"))
    .addColumn("title", "text", (col) => col.notNull())
    .addColumn("summary", "text", (col) => col.notNull().defaultTo(""))
    .addColumn("device", "text", (col) => col.notNull().defaultTo("ambos"))
    .addColumn("sources", "jsonb", (col) =>
      col.notNull().defaultTo(sql`'[]'::jsonb`),
    )
    .addColumn("money", "jsonb")
    .addColumn("confidence", "double precision", (col) =>
      col.notNull().defaultTo(0.5),
    )
    .addColumn("metric", "jsonb")
    .addColumn("measured", "jsonb")
    .addColumn("reliability", "jsonb")
    .addColumn("drilldown", "jsonb")
    .addColumn("tree_notes", "jsonb")
    .addColumn("outcome", "jsonb")
    .addColumn("observations", "jsonb")
    .addColumn("updated_at", "timestamptz", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("plan_ux_opportunities_diagnosis")
    .on("plan_ux_opportunities")
    .columns(["diagnosis_id", "rank"])
    .execute();

  await db.schema
    .createTable("plan_ux_hypotheses")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("diagnosis_id", "text", (col) =>
      col.notNull().references("plan_ux_diagnoses.id").onDelete("cascade"),
    )
    // Not a foreign key: retiring an opportunity moves its id.
    .addColumn("opportunity_id", "text")
    .addColumn("rank", "integer", (col) => col.notNull())
    .addColumn("kind", "text", (col) => col.notNull().defaultTo("proposta"))
    .addColumn("title", "text", (col) => col.notNull())
    .addColumn("device", "text", (col) => col.notNull().defaultTo("mobile"))
    .addColumn("evidence_md", "text", (col) => col.notNull().defaultTo(""))
    .addColumn("idea", "text", (col) => col.notNull().defaultTo(""))
    .addColumn("why", "text", (col) => col.notNull().defaultTo(""))
    .addColumn("where", "text", (col) => col.notNull().defaultTo(""))
    .addColumn("money", "jsonb")
    .addColumn("confidence", "double precision", (col) =>
      col.notNull().defaultTo(0.5),
    )
    .addColumn("benchmark_refs", "jsonb", (col) =>
      col.notNull().defaultTo(sql`'[]'::jsonb`),
    )
    .addColumn("benchmark", "jsonb", (col) =>
      col.notNull().defaultTo(sql`'[]'::jsonb`),
    )
    .addColumn("before_url", "text")
    .addColumn("after_url", "text")
    .addColumn("after_patch", "text")
    .addColumn("mockup_error", "text")
    .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("status_note", "text")
    .addColumn("code_status", "text")
    .addColumn("code_note", "text")
    .addColumn("code_before_url", "text")
    .addColumn("code_after_url", "text")
    .addColumn("code_diff", "text")
    .addColumn("code_error", "text")
    .addColumn("code_started_at", "timestamptz")
    .addColumn("verification", "jsonb")
    .addColumn("category", "text")
    .addColumn("tree", "jsonb")
    .addColumn("lifecycle", "text")
    .addColumn("lifecycle_log", "jsonb")
    .addColumn("validation", "jsonb")
    .addColumn("relevance", "jsonb")
    .addColumn("experiment", "jsonb")
    .addColumn("priority", "jsonb")
    // Test priority (0–1) the approved queue sorts by; null until ready.
    .addColumn("priority_test", "double precision")
    .addColumn("review", "jsonb")
    .addColumn("updated_at", "timestamptz", (col) => col.notNull())
    .addCheckConstraint(
      "plan_ux_hypotheses_kind",
      sql`kind IN ('proposta', 'nao_faria')`,
    )
    .addCheckConstraint(
      "plan_ux_hypotheses_status",
      sql`status IN ('pending', 'approved', 'dismissed')`,
    )
    .addCheckConstraint(
      "plan_ux_hypotheses_code_status",
      sql`code_status IS NULL OR code_status IN ('running', 'done', 'error')`,
    )
    .addCheckConstraint(
      "plan_ux_hypotheses_lifecycle",
      sql`lifecycle IS NULL OR lifecycle IN (
        'gerada', 'em_investigacao', 'condicao_confirmada',
        'relevancia_avaliada', 'pronta_para_experimento', 'refutada',
        'inconclusiva', 'bloqueada', 'sem_relevancia')`,
    )
    .execute();

  await db.schema
    .createIndex("plan_ux_hypotheses_diagnosis")
    .on("plan_ux_hypotheses")
    .columns(["diagnosis_id", "rank"])
    .execute();
  await db.schema
    .createIndex("plan_ux_hypotheses_opportunity")
    .on("plan_ux_hypotheses")
    .column("opportunity_id")
    .execute();

  // Competitors' public pages, reused for 30 days instead of recaptured.
  await db.schema
    .createTable("plan_ux_benchmark_pdps")
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    // The domain for a PDP; `domain#page_type` for other pages.
    .addColumn("domain", "text", (col) => col.notNull())
    .addColumn("url", "text", (col) => col.notNull())
    .addColumn("screenshot_url", "text")
    .addColumn("full_url", "text")
    .addColumn("anatomy", "jsonb", (col) => col.notNull())
    .addColumn("captured_at", "timestamptz", (col) => col.notNull())
    .addPrimaryKeyConstraint("plan_ux_benchmark_pdps_pkey", [
      "organization_id",
      "domain",
    ])
    .execute();

  await db.schema
    .createTable("plan_ux_knowledge")
    // Manual: a uuid. Learned: `<origin>:<hypothesis id>`.
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("conhecimento", "text", (col) => col.notNull())
    .addColumn("categoria", "text", (col) => col.notNull())
    .addColumn("fonte", "text", (col) => col.notNull().defaultTo(""))
    .addColumn("fonte_url", "text")
    .addColumn("tipo_fonte", "text", (col) => col.notNull())
    .addColumn("contexto", "text", (col) => col.notNull().defaultTo(""))
    .addColumn("areas", "jsonb", (col) =>
      col.notNull().defaultTo(sql`'[]'::jsonb`),
    )
    .addColumn("evidencia", "text", (col) => col.notNull().defaultTo(""))
    .addColumn("trecho", "text")
    .addColumn("assinatura", "text")
    .addColumn("confiabilidade", "text", (col) =>
      col.notNull().defaultTo("media"),
    )
    .addColumn("limitacoes", "text", (col) => col.notNull().defaultTo(""))
    .addColumn("resultado", "text")
    .addColumn("origem", "text", (col) => col.notNull())
    .addColumn("diagnosis_id", "text")
    .addColumn("hypothesis_id", "text")
    .addColumn("active", "boolean", (col) => col.notNull().defaultTo(true))
    .addColumn("created_at", "timestamptz", (col) => col.notNull())
    .addColumn("updated_at", "timestamptz", (col) => col.notNull())
    .addCheckConstraint(
      "plan_ux_knowledge_categoria",
      sql`categoria IN ('ux', 'performance', 'confianca', 'comercial', 'trafego', 'tecnologia')`,
    )
    .addCheckConstraint(
      "plan_ux_knowledge_tipo_fonte",
      sql`tipo_fonte IN ('ab_desta_loja', 'veredito_desta_loja', 'estudo', 'ab_outra_loja', 'benchmark', 'boa_pratica', 'opiniao')`,
    )
    .addCheckConstraint(
      "plan_ux_knowledge_confiabilidade",
      sql`confiabilidade IN ('alta', 'media', 'baixa')`,
    )
    .addCheckConstraint(
      "plan_ux_knowledge_resultado",
      sql`resultado IS NULL OR resultado IN ('positivo', 'negativo', 'neutro', 'confirmada', 'refutada')`,
    )
    .addCheckConstraint(
      "plan_ux_knowledge_origem",
      sql`origem IN ('manual', 'veredito', 'decisao')`,
    )
    .execute();

  await db.schema
    .createIndex("plan_ux_knowledge_org_updated")
    .on("plan_ux_knowledge")
    .columns(["organization_id", "updated_at desc"])
    .execute();

  // Append-only; the deterministic id keeps a retried step from counting twice.
  await db.schema
    .createTable("plan_cost_events")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("at", "timestamptz", (col) => col.notNull())
    .addColumn("provider", "text", (col) => col.notNull())
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("feature", "text", (col) => col.notNull())
    .addColumn("model", "text")
    .addColumn("units_in", "bigint")
    .addColumn("units_out", "bigint")
    // Null: it happened and has no known price. Never 0.
    .addColumn("cost_usd", "double precision")
    .addColumn("execution_id", "text")
    .addColumn("job_id", "text")
    .addColumn("product_id", "text")
    .addColumn("created_at", "timestamptz", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("plan_cost_events_org_at")
    .on("plan_cost_events")
    .columns(["organization_id", "at desc"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("plan_cost_events").ifExists().execute();
  await db.schema.dropTable("plan_ux_knowledge").ifExists().execute();
  await db.schema.dropTable("plan_ux_benchmark_pdps").ifExists().execute();
  await db.schema.dropTable("plan_ux_hypotheses").ifExists().execute();
  await db.schema.dropTable("plan_ux_opportunities").ifExists().execute();
  await db.schema.dropTable("plan_ux_diagnoses").ifExists().execute();
  await db.schema.dropTable("plan_ux_site_profiles").ifExists().execute();
}
