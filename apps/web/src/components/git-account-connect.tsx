/**
 * Connecting a git provider account, as one staged flow: provider, then — only
 * where there is a choice — method. Settings and the repository picker share
 * it, so `layout` decides the trigger and nothing else.
 *
 * Token before OAuth: the provider narrows a scoped token, an OAuth grant
 * reaches everything its user can. Said as a label, not a confirmation step.
 */

import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  ChevronRight,
  LinkExternal01,
  Plus,
} from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import {
  DEFAULT_HOSTS,
  type GitProviderKind,
} from "@decocms/shared/git-providers";
import { GitProviderIcon } from "@/components/icons/git-provider-icon";
import {
  type GitProviderCapabilities,
  useGitProviderCapabilities,
  useConnectGitAccountToken,
  useConnectGithubCli,
} from "@/hooks/use-git-providers";
import { useDeploymentAdmin } from "@/hooks/use-deployment-admin";
import { useProjectContext } from "@/sdk";
import { useT } from "@/i18n/use-t.ts";
import { errorMessage } from "@/lib/error-message";

/** The providers that accept a pasted access token (GitHub connects through its App). */
type TokenProvider = "gitlab" | "bitbucket";

type Key = Parameters<ReturnType<typeof useT>>[0];

type Stage =
  | { name: "provider" }
  | { name: "method"; provider: GitProviderKind }
  | { name: "token"; provider: TokenProvider };

/** How one provider can be connected on this deployment. `href` navigates; a token opens the form. */
interface ConnectMethod {
  kind: "app" | "oauth" | "token" | "cli";
  href?: string;
}

const PROVIDER_COPY: Record<GitProviderKind, { label: Key }> = {
  github: { label: "settings.repositories.providerGithub" },
  gitlab: { label: "settings.repositories.providerGitlab" },
  bitbucket: { label: "settings.repositories.providerBitbucket" },
};

/**
 * What a row promises, from what this deployment configured — offering OAuth
 * without an application is a dead end found one click later.
 */
function providerHint(
  provider: GitProviderKind,
  methods: ConnectMethod[],
): Key {
  if (methods.length === 0) return "settings.repositories.githubUnavailable";
  if (provider === "github") {
    return methods.some((method) => method.kind === "cli")
      ? "settings.repositories.githubCliHint"
      : "settings.repositories.providerGithubHint";
  }
  return methods.length > 1
    ? "settings.repositories.providerTokenOrOauthHint"
    : "settings.repositories.providerTokenOnlyHint";
}

/** Per-provider copy for the token form: which fields it asks for and the steps it shows. */
const TOKEN_COPY: Record<
  TokenProvider,
  {
    title: Key;
    description: Key;
    placeholder: Key;
    steps: [Key, Key, Key, Key];
    askHost: boolean;
    askWorkspace: boolean;
    askProject: boolean;
  }
> = {
  gitlab: {
    title: "settings.repositories.tokenDialogTitle",
    description: "settings.repositories.tokenDialogDescription",
    placeholder: "settings.repositories.tokenPlaceholder",
    steps: [
      "settings.repositories.gitlabStep1",
      "settings.repositories.gitlabStep2",
      "settings.repositories.gitlabStep3",
      "settings.repositories.gitlabStep4",
    ],
    askHost: true,
    askWorkspace: false,
    askProject: true,
  },
  bitbucket: {
    title: "settings.repositories.tokenDialogTitleBitbucket",
    description: "settings.repositories.tokenDialogDescriptionBitbucket",
    placeholder: "settings.repositories.tokenPlaceholderBitbucket",
    steps: [
      "settings.repositories.bitbucketStep1",
      "settings.repositories.bitbucketStep2",
      "settings.repositories.bitbucketStep3",
      "settings.repositories.bitbucketStep4",
    ],
    askHost: false,
    askWorkspace: true,
    askProject: false,
  },
};

const PROVIDER_ORDER: GitProviderKind[] = ["github", "gitlab", "bitbucket"];

/** The admin dashboard page that registers the deployment's GitHub App. */
const GITHUB_APP_SETUP_PATH = "/_admin/github";

/**
 * The ways `provider` can be connected here, token first. Empty for GitHub
 * with neither local CLI access nor an App configured.
 */
function methodsFor(
  provider: GitProviderKind,
  capabilities: GitProviderCapabilities | undefined,
  connectUrl: (path: string) => string,
): ConnectMethod[] {
  if (provider === "github") {
    const github = capabilities?.github;
    if (github?.cliConnectPath) return [{ kind: "cli" }];
    return github?.configured && github.connectPath
      ? [{ kind: "app", href: connectUrl(github.connectPath) }]
      : [];
  }
  const oauth =
    provider === "gitlab" ? capabilities?.gitlab : capabilities?.bitbucket;
  const methods: ConnectMethod[] = [{ kind: "token" }];
  if (oauth && oauth.oauthHosts.length > 0 && oauth.connectPath) {
    methods.push({ kind: "oauth", href: connectUrl(oauth.connectPath) });
  }
  return methods;
}

/**
 * Where the provider mints the token, aimed as deep as the fields allow.
 * GitLab prefills from `name` and `scopes`; a host that ignores them is fine.
 */
function tokenPageUrl(
  provider: TokenProvider,
  fields: { host: string; workspace: string; project: string },
): string | null {
  if (provider === "bitbucket") {
    const workspace = fields.workspace.trim();
    return workspace
      ? `https://bitbucket.org/${encodeURIComponent(workspace)}/workspace/repositories`
      : null;
  }
  const host = fields.host.trim();
  if (!host) return null;
  const project = fields.project.trim().replace(/^\/+|\/+$/g, "");
  const query = "?name=Studio&scopes=api";
  return project
    ? `https://${host}/${project}/-/settings/access_tokens${query}`
    : `https://${host}/-/user_settings/personal_access_tokens${query}`;
}

export function GitAccountConnect({
  layout = "buttons",
  disabled = false,
}: {
  layout?: "buttons" | "picker";
  disabled?: boolean;
}) {
  const t = useT();
  const [stage, setStage] = useState<Stage | null>(null);
  const open = () => setStage({ name: "provider" });

  return (
    <>
      {layout === "picker" ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={open}
          // Without this the name is the title AND the description read together.
          aria-label={t("settings.repositories.addAccount")}
          className="w-full h-auto justify-start gap-3 rounded-none px-4 py-3 hover:bg-accent"
        >
          <span className="size-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
            <Plus size={16} />
          </span>
          <span className="flex-1 min-w-0 text-left">
            <span className="block text-sm font-medium">
              {t("settings.repositories.addAccount")}
            </span>
            <span className="block text-xs font-normal text-muted-foreground whitespace-normal">
              {t("settings.repositories.addAccountDescription")}
            </span>
          </span>
          <span className="shrink-0 text-muted-foreground">
            <ChevronRight size={16} />
          </span>
        </Button>
      ) : (
        <Button variant="outline" size="sm" disabled={disabled} onClick={open}>
          <Plus size={16} />
          {t("settings.repositories.addAccount")}
        </Button>
      )}
      {stage && (
        <AddAccountDialog
          stage={stage}
          onStage={setStage}
          onClose={() => setStage(null)}
        />
      )}
    </>
  );
}

function AddAccountDialog({
  stage,
  onStage,
  onClose,
}: {
  stage: Stage;
  onStage: (stage: Stage) => void;
  onClose: () => void;
}) {
  const t = useT();
  const capabilities = useGitProviderCapabilities();
  // A deployment admin can fix "GitHub isn't configured" themselves, in one
  // click from the admin dashboard — so the row links there instead of
  // telling them to ask an administrator.
  const { isAdmin: isDeploymentAdmin } = useDeploymentAdmin();
  const cliConnect = useConnectGithubCli();
  const { org } = useProjectContext();
  const returnTo = `/${org.slug}/settings/repositories`;
  const connectUrl = (path: string) =>
    `${path}?returnTo=${encodeURIComponent(returnTo)}`;

  function choose(provider: GitProviderKind) {
    const methods = methodsFor(provider, capabilities.data, connectUrl);
    const only = methods.length === 1 ? methods[0] : undefined;
    if (only?.kind === "cli") {
      cliConnect.mutate(undefined, {
        onSuccess: (account) => {
          toast.success(
            t("settings.repositories.connected", { login: account.login }),
          );
          onClose();
        },
        onError: (error) =>
          toast.error(errorMessage(error, t("settings.repositories.failed"))),
      });
      return;
    }
    if (only?.href) {
      globalThis.location.href = only.href;
      return;
    }
    if (only?.kind === "token") {
      onStage({ name: "token", provider: provider as TokenProvider });
      return;
    }
    onStage({ name: "method", provider });
  }

  // Back to where the user came from; a skipped stage is a dead end.
  const back = (provider: TokenProvider) =>
    onStage(
      methodsFor(provider, capabilities.data, connectUrl).length > 1
        ? { name: "method", provider }
        : { name: "provider" },
    );

  const title =
    stage.name === "token"
      ? t(TOKEN_COPY[stage.provider].title)
      : stage.name === "method"
        ? t(PROVIDER_COPY[stage.provider].label)
        : t("settings.repositories.addAccountTitle");
  const description =
    stage.name === "token"
      ? t(TOKEN_COPY[stage.provider].description)
      : stage.name === "method"
        ? t("settings.repositories.chooseMethodDescription")
        : t("settings.repositories.addAccountDescription");

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {stage.name === "token" ? (
          <TokenForm
            provider={stage.provider}
            onBack={() => back(stage.provider)}
            onClose={onClose}
          />
        ) : capabilities.isError ? (
          <div className="flex flex-col items-start gap-2">
            <p role="alert" className="text-sm text-destructive">
              {t("settings.repositories.failed")}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => capabilities.refetch()}
            >
              {t("settings.repositories.tryAgain")}
            </Button>
          </div>
        ) : capabilities.isPending ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : stage.name === "provider" ? (
          <div className="flex flex-col gap-1">
            {PROVIDER_ORDER.map((provider) => {
              const methods = methodsFor(
                provider,
                capabilities.data,
                connectUrl,
              );
              const setupHref =
                provider === "github" &&
                methods.length === 0 &&
                isDeploymentAdmin
                  ? GITHUB_APP_SETUP_PATH
                  : undefined;
              return (
                <OptionRow
                  key={provider}
                  icon={<GitProviderIcon provider={provider} size={16} />}
                  label={t(
                    methods[0]?.kind === "cli"
                      ? "settings.repositories.connectGithubCli"
                      : PROVIDER_COPY[provider].label,
                  )}
                  description={t(
                    setupHref
                      ? "settings.repositories.githubSetupHint"
                      : providerHint(provider, methods),
                  )}
                  disabled={
                    !setupHref && (methods.length === 0 || cliConnect.isPending)
                  }
                  href={setupHref}
                  onClick={setupHref ? undefined : () => choose(provider)}
                />
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {methodsFor(stage.provider, capabilities.data, connectUrl).map(
              (method) => (
                <OptionRow
                  key={method.kind}
                  icon={<GitProviderIcon provider={stage.provider} size={16} />}
                  label={t(
                    method.kind === "cli"
                      ? "settings.repositories.connectGithubCli"
                      : method.kind === "token"
                        ? "settings.repositories.methodToken"
                        : method.kind === "oauth"
                          ? "settings.repositories.methodOauth"
                          : "settings.repositories.methodApp",
                  )}
                  description={t(
                    method.kind === "cli"
                      ? "settings.repositories.githubCliHint"
                      : method.kind === "token"
                        ? "settings.repositories.methodTokenHint"
                        : method.kind === "oauth"
                          ? "settings.repositories.methodOauthHint"
                          : "settings.repositories.methodAppHint",
                  )}
                  note={
                    method.kind === "oauth"
                      ? t("settings.repositories.methodOauthScopeNote")
                      : undefined
                  }
                  href={method.href}
                  onClick={
                    method.kind === "cli"
                      ? () => choose(stage.provider)
                      : method.kind === "token"
                        ? () =>
                            onStage({
                              name: "token",
                              provider: stage.provider as TokenProvider,
                            })
                        : undefined
                  }
                />
              ),
            )}
          </div>
        )}

        {stage.name === "method" && (
          <DialogFooter className="sm:justify-start">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onStage({ name: "provider" })}
            >
              <ArrowLeft size={16} />
              {t("settings.repositories.back")}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** One choice in the flow — a provider, or a way to connect one. */
function OptionRow({
  icon,
  label,
  description,
  note,
  href,
  onClick,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  description: string;
  note?: string;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  const content = (
    <>
      <span className="size-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
        {icon}
      </span>
      <span className="flex-1 min-w-0 text-left">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs font-normal text-muted-foreground whitespace-normal">
          {description}
        </span>
        {note && (
          <span className="block text-xs font-normal text-warning whitespace-normal mt-0.5">
            {note}
          </span>
        )}
      </span>
      {!disabled && (
        <span className="shrink-0 text-muted-foreground">
          <ChevronRight size={16} />
        </span>
      )}
    </>
  );
  const button = (
    <Button
      variant="ghost"
      aria-label={label}
      disabled={disabled}
      asChild={!!href && !disabled}
      onClick={onClick}
      className="w-full h-auto justify-start gap-3 px-3 py-3 hover:bg-accent"
    >
      {href && !disabled ? <a href={href}>{content}</a> : content}
    </Button>
  );
  return disabled ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0}>{button}</span>
      </TooltipTrigger>
      <TooltipContent>{description}</TooltipContent>
    </Tooltip>
  ) : (
    button
  );
}

/** The token stage's body, rendered inside the flow's one dialog. */
function TokenForm({
  provider,
  onBack,
  onClose,
}: {
  provider: TokenProvider;
  onBack: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const copy = TOKEN_COPY[provider];
  const connect = useConnectGitAccountToken();
  const [host, setHost] = useState(DEFAULT_HOSTS[provider]);
  const [workspace, setWorkspace] = useState("");
  const [project, setProject] = useState("");
  const [token, setToken] = useState("");

  const ready =
    !!host.trim() &&
    !!token.trim() &&
    (!copy.askWorkspace || !!workspace.trim());
  const providerPage = tokenPageUrl(provider, { host, workspace, project });

  function handleConnect() {
    if (!ready) return;
    connect.mutate(
      {
        type: provider,
        host: host.trim(),
        token: token.trim(),
        ...(copy.askWorkspace ? { workspace: workspace.trim() } : {}),
      },
      {
        onSuccess: (account) => {
          toast.success(
            t("settings.repositories.connected", { login: account.login }),
          );
          setToken("");
          onClose();
        },
        onError: (err) =>
          toast.error(errorMessage(err, t("settings.repositories.failed"))),
      },
    );
  }

  return (
    <>
      <div className="flex flex-col gap-3">
        {copy.askHost && (
          <Field
            id={`${provider}-host`}
            label={t("settings.repositories.tokenHostLabel")}
            value={host}
            onChange={setHost}
            placeholder={t("settings.repositories.tokenHostPlaceholder")}
          />
        )}
        {copy.askWorkspace && (
          <Field
            id={`${provider}-workspace`}
            label={t("settings.repositories.tokenWorkspaceLabel")}
            value={workspace}
            onChange={setWorkspace}
            placeholder={t("settings.repositories.tokenWorkspacePlaceholder")}
            hint={t("settings.repositories.tokenWorkspaceHint")}
          />
        )}
        {copy.askProject && (
          <Field
            id={`${provider}-project`}
            label={t("settings.repositories.tokenProjectLabel")}
            value={project}
            onChange={setProject}
            placeholder={t("settings.repositories.tokenProjectPlaceholder")}
            hint={t("settings.repositories.tokenProjectHint")}
          />
        )}

        <div className="rounded-lg border border-border/60 bg-muted/40 p-3 flex flex-col gap-2">
          <p className="text-xs font-medium">
            {t("settings.repositories.tokenStepsTitle")}
          </p>
          <ol className="flex flex-col gap-1 list-decimal pl-4 text-xs text-muted-foreground">
            {copy.steps.map((step) => (
              <li key={step}>{t(step)}</li>
            ))}
          </ol>
          {providerPage && (
            <Button variant="outline" size="sm" className="self-start" asChild>
              <a href={providerPage} target="_blank" rel="noreferrer">
                <LinkExternal01 size={14} />
                {t("settings.repositories.openProvider")}
              </a>
            </Button>
          )}
        </div>

        <Field
          id={`${provider}-token`}
          label={t("settings.repositories.tokenLabel")}
          value={token}
          onChange={setToken}
          placeholder={t(copy.placeholder)}
          type="password"
        />
      </div>

      <DialogFooter className="sm:justify-between">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          disabled={connect.isPending}
        >
          <ArrowLeft size={16} />
          {t("settings.repositories.back")}
        </Button>
        <Button onClick={handleConnect} disabled={!ready || connect.isPending}>
          {connect.isPending
            ? t("settings.repositories.connecting")
            : t("settings.repositories.connect")}
        </Button>
      </DialogFooter>
    </>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
  hint,
  type,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  hint?: string;
  type?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
