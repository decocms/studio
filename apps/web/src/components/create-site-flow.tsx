/**
 * "Create a new site", staged inside the repository picker: a template, then
 * the GitHub account that owns the new repository, then its name.
 */

import { type FormEvent, useState } from "react";
import {
  ArrowLeft,
  BookOpen01,
  ChevronRight,
  ShoppingBag01,
} from "@untitledui/icons";
import {
  SITE_TEMPLATES,
  SiteRepoNameSchema,
  type SiteTemplateId,
} from "@decocms/shared/site-templates";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { GitAccountConnect } from "@/components/git-account-connect";
import {
  GitAccountAvatar,
  GitAccountList,
} from "@/components/git-account-list";
import type { GitAccount } from "@/hooks/use-git-providers";
import { type TranslationKey, useT } from "@/i18n/use-t.ts";

const TEMPLATE_COPY = {
  storefront: {
    icon: ShoppingBag01,
    title: "common.createSite.templates.storefront.title",
    description: "common.createSite.templates.storefront.description",
  },
  blog: {
    icon: BookOpen01,
    title: "common.createSite.templates.blog.title",
    description: "common.createSite.templates.blog.description",
  },
} as const satisfies Record<
  SiteTemplateId,
  {
    icon: typeof BookOpen01;
    title: TranslationKey;
    description: TranslationKey;
  }
>;

export interface CreateSiteRequest {
  template: SiteTemplateId;
  account: GitAccount;
  name: string;
}

type Step =
  | { kind: "template" }
  | { kind: "account"; template: SiteTemplateId }
  | { kind: "name"; template: SiteTemplateId; account: GitAccount };

export function templateTitleKey(template: SiteTemplateId): TranslationKey {
  return TEMPLATE_COPY[template].title;
}

export function CreateSiteFlow({
  accounts,
  pending,
  onExit,
  onCreate,
}: {
  /** Serviceable GitHub accounts: the only ones that can own a new site. */
  accounts: GitAccount[];
  pending: boolean;
  onExit: () => void;
  onCreate: (request: CreateSiteRequest) => void;
}) {
  const t = useT();
  const [step, setStep] = useState<Step>({ kind: "template" });

  function back() {
    if (step.kind === "template") onExit();
    else if (step.kind === "account") setStep({ kind: "template" });
    else setStep({ kind: "account", template: step.template });
  }

  return (
    <>
      <div className="flex items-center h-12 border-b border-border px-4 pr-12 gap-3 shrink-0">
        <Button
          size="icon"
          variant="ghost"
          className="size-6 -ml-1"
          disabled={pending}
          onClick={back}
          aria-label={t("common.repositoryPicker.back")}
        >
          <ArrowLeft size={16} />
        </Button>
        <span className="text-sm font-medium truncate">
          {t("common.createSite.entry")}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {step.kind === "template" && (
          <div className="py-2">
            <p className="px-4 py-2 text-xs font-medium text-muted-foreground">
              {t("common.createSite.templateSection")}
            </p>
            {SITE_TEMPLATES.map(({ id }) => {
              const copy = TEMPLATE_COPY[id];
              const Icon = copy.icon;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setStep({ kind: "account", template: id })}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-accent transition-colors focus-visible:outline-none focus-visible:bg-accent"
                >
                  <div className="size-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
                    <Icon size={16} className="text-muted-foreground" />
                  </div>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-medium truncate">
                      {t(copy.title)}
                    </span>
                    <span className="block text-xs text-muted-foreground truncate">
                      {t(copy.description)}
                    </span>
                  </span>
                  <ChevronRight
                    size={16}
                    className="shrink-0 text-muted-foreground"
                  />
                </button>
              );
            })}
          </div>
        )}
        {step.kind === "account" && (
          <>
            {accounts.length > 0 ? (
              <GitAccountList
                title={t("common.createSite.accountSection")}
                accounts={accounts}
                onSelect={(account) =>
                  setStep({ kind: "name", template: step.template, account })
                }
                disabled={pending}
              />
            ) : (
              <p className="px-4 pt-4 pb-2 text-sm text-muted-foreground">
                {t("common.createSite.noGithubAccount")}
              </p>
            )}
            <div className="border-t border-border py-2">
              <p className="px-4 py-2 text-xs text-muted-foreground leading-relaxed">
                {t("common.createSite.accountHint")}
              </p>
              <GitAccountConnect layout="picker" disabled={pending} />
            </div>
          </>
        )}
        {step.kind === "name" && (
          <NameStep
            account={step.account}
            pending={pending}
            onSubmit={(name) =>
              onCreate({ template: step.template, account: step.account, name })
            }
          />
        )}
      </div>
    </>
  );
}

function NameStep({
  account,
  pending,
  onSubmit,
}: {
  account: GitAccount;
  pending: boolean;
  onSubmit: (name: string) => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const parsed = SiteRepoNameSchema.safeParse(name);
  const showInvalid = name.length > 0 && !parsed.success;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (parsed.success && !pending) onSubmit(parsed.data);
  }

  return (
    <form onSubmit={submit} className="p-4 flex flex-col gap-4">
      <div className="flex items-center gap-2 text-sm">
        <GitAccountAvatar account={account} className="size-6" />
        <span className="font-medium truncate">{account.login}</span>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="create-site-name">
          {t("common.createSite.nameLabel")}
        </Label>
        <Input
          id="create-site-name"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={name}
          disabled={pending}
          placeholder={t("common.createSite.namePlaceholder")}
          aria-invalid={showInvalid}
          onChange={(e) =>
            setName(e.target.value.toLowerCase().replace(/[\s_]+/g, "-"))
          }
        />
        <p
          className={cn(
            "text-xs",
            showInvalid ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {showInvalid
            ? t("common.createSite.nameInvalid")
            : t("common.createSite.nameHint", {
                path: `${account.login}/${name.trim() || t("common.createSite.namePlaceholder")}`,
              })}
        </p>
      </div>
      <Button type="submit" disabled={!parsed.success || pending}>
        {pending && <Spinner className="size-4" />}
        {t("common.createSite.create")}
      </Button>
    </form>
  );
}
