import type { Database } from "@/storage/types";
import { type GoalLedger, type GoalSource, UnmovedMover } from "@decocms/telos";
import type { Kysely } from "kysely";
import type { OnboardingTarget } from "./target";

// DB-backed GoalLedger over telos_goal. Append-only; one lineage per org.
export class KyselyGoalLedger implements GoalLedger<OnboardingTarget> {
  constructor(private readonly db: Kysely<Database>) {}

  async install(
    tenant: string,
    target: OnboardingTarget,
    source: GoalSource = "authority",
  ): Promise<UnmovedMover<OnboardingTarget>> {
    const version = (await this.movers(tenant)).length + 1;
    await this.db
      .insertInto("telos_goal")
      .values({
        id: `goal_${crypto.randomUUID()}`,
        organization_id: tenant,
        version,
        source,
        target: JSON.stringify(target),
        created_by: null,
      })
      .execute();
    return new UnmovedMover({ tenant, version, target, source });
  }

  async latest(tenant: string): Promise<UnmovedMover<OnboardingTarget>> {
    const latest = (await this.movers(tenant)).at(-1);
    if (!latest) throw new Error(`no UnmovedMover for tenant ${tenant}`);
    return latest;
  }

  async anchor(tenant: string): Promise<UnmovedMover<OnboardingTarget>> {
    const anchor = (await this.movers(tenant))
      .filter((m) => m.source === "authority")
      .at(-1);
    if (!anchor)
      throw new Error(`no anchor (authority goal) for tenant ${tenant}`);
    return anchor;
  }

  async history(
    tenant: string,
  ): Promise<readonly UnmovedMover<OnboardingTarget>[]> {
    return this.movers(tenant);
  }

  private async movers(
    tenant: string,
  ): Promise<UnmovedMover<OnboardingTarget>[]> {
    const rows = await this.db
      .selectFrom("telos_goal")
      .selectAll()
      .where("organization_id", "=", tenant)
      .orderBy("version", "asc")
      .execute();
    return rows.map(
      (r) =>
        new UnmovedMover({
          tenant: r.organization_id,
          version: r.version,
          target: asTarget(r.target),
          source: r.source as GoalSource,
        }),
    );
  }
}

function asTarget(value: unknown): OnboardingTarget {
  return (
    typeof value === "string" ? JSON.parse(value) : value
  ) as OnboardingTarget;
}
