import RequiredAuthLayout from "@/web/layouts/required-auth-layout";
import { AuthSplitLayout } from "@/web/components/auth-split-layout";
import { authClient } from "@/web/lib/auth-client";
import { KEYS } from "@/web/lib/query-keys";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  Building02,
  CheckCircle,
  Globe04,
  Loading01,
  Palette,
  Upload01,
  Users03,
} from "@untitledui/icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";

const GENERIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "yahoo.co.uk",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "protonmail.com",
  "proton.me",
  "zoho.com",
  "yandex.com",
  "mail.com",
  "gmx.com",
  "gmx.net",
  "tutanota.com",
  "fastmail.com",
]);

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s_-]+/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

interface DomainLookupResult {
  found: boolean;
  autoJoinEnabled?: boolean;
  organization?: { name: string; slug: string } | null;
}

interface DomainSetupResult {
  success: boolean;
  slug?: string;
  brandExtracted?: boolean;
  alreadyExists?: boolean;
  error?: string;
}

export default function OnboardingRoute() {
  return (
    <RequiredAuthLayout>
      <OnboardingPage />
    </RequiredAuthLayout>
  );
}

function OnboardingHeader({
  title,
  description,
  logoUrl,
  logoFallback,
}: {
  title: string;
  description: string;
  /** Override the default deco logo with an org logo URL (e.g. favicon). */
  logoUrl?: string | null;
  /** Single-character fallback shown when logoUrl fails or is missing. */
  logoFallback?: string;
}) {
  return (
    <div className="grid gap-10">
      <div>
        {logoUrl ? (
          <Avatar
            url={logoUrl}
            fallback={logoFallback ?? "?"}
            shape="square"
            size="base"
            className="h-12 w-12"
          />
        ) : (
          <>
            <img
              src="/logos/deco logo.svg"
              alt="Deco"
              className="h-12 w-12 dark:hidden"
            />
            <img
              src="/logos/deco logo negative.svg"
              alt="Deco"
              className="h-12 w-12 hidden dark:block"
            />
          </>
        )}
      </div>
      <div className="space-y-2">
        <h1 className="text-2xl font-medium leading-8">{title}</h1>
        <p className="text-base text-muted-foreground leading-6">
          {description}
        </p>
      </div>
    </div>
  );
}

function OnboardingPage() {
  const { data: session, isPending: sessionLoading } = authClient.useSession();

  if (sessionLoading) {
    return (
      <AuthSplitLayout>
        <div className="flex items-center gap-2">
          <Loading01 size={14} className="animate-spin text-muted-foreground" />
        </div>
      </AuthSplitLayout>
    );
  }

  const userEmail = session?.user?.email ?? "";
  return <OnboardingContent email={userEmail} userName={session?.user?.name} />;
}

function OnboardingContent({
  email,
  userName,
}: {
  email: string;
  userName?: string | null;
}) {
  const emailDomain = email.split("@")[1]?.toLowerCase() ?? "";
  const isCorporateEmail =
    !!emailDomain && !GENERIC_EMAIL_DOMAINS.has(emailDomain);
  const domainName = emailDomain.split(".")[0] ?? "";
  const domainLabel = domainName.charAt(0).toUpperCase() + domainName.slice(1);
  const defaultName = isCorporateEmail
    ? domainLabel
    : (userName?.split(" ")[0] ?? "");

  const { data: domainLookup, isLoading: domainLoading } =
    useQuery<DomainLookupResult>({
      queryKey: KEYS.domainLookup(emailDomain),
      queryFn: async () => {
        const res = await fetch("/api/auth/custom/domain-lookup", {
          credentials: "include",
        });
        return res.json();
      },
      enabled: isCorporateEmail,
    });

  const joinOrgMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/auth/custom/domain-join", {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to join organization");
      }
      window.location.href = `/${data.slug}`;
    },
  });

  if (domainLoading) {
    return (
      <AuthSplitLayout>
        <div className="flex items-center gap-2 py-4">
          <Loading01 size={14} className="animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">
            Checking {emailDomain}...
          </span>
        </div>
      </AuthSplitLayout>
    );
  }

  const hasMatchingOrg = domainLookup?.found && domainLookup?.organization;
  const canAutoJoin = hasMatchingOrg && domainLookup?.autoJoinEnabled;

  const [creatingNewOrg, setCreatingNewOrg] = useState(false);

  if (creatingNewOrg) {
    return (
      <SetupForm
        isCorporateEmail={isCorporateEmail}
        emailDomain={emailDomain}
        domainLabel={domainLabel}
        defaultName={userName?.split(" ")[0] ?? ""}
        allowDomainClaim={false}
        onBack={() => setCreatingNewOrg(false)}
      />
    );
  }

  // Domain already has an auto-join org → show join card + option to create own org
  if (canAutoJoin) {
    const org = domainLookup.organization!;
    return (
      <AuthSplitLayout>
        <div className="grid gap-10">
          <OnboardingHeader
            title="You have access to an organization"
            description="Your email domain matches an existing organization."
          />
          <div className="rounded-xl card-shadow bg-background dark:bg-input/30 p-4 flex items-center gap-4">
            <Avatar
              url={`https://www.google.com/s2/favicons?domain=${emailDomain}&sz=128`}
              fallback={org.name.charAt(0).toUpperCase()}
              shape="square"
              size="base"
              className="h-10 w-10 shrink-0"
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{org.name}</p>
              <p className="text-xs text-muted-foreground truncate">
                @{emailDomain}
              </p>
            </div>
            <Button
              size="default"
              onClick={() => joinOrgMutation.mutate()}
              disabled={joinOrgMutation.isPending}
            >
              {joinOrgMutation.isPending ? (
                <span className="flex items-center gap-2">
                  <Loading01 size={14} className="animate-spin" /> Joining...
                </span>
              ) : (
                "Join"
              )}
            </Button>
          </div>
          {joinOrgMutation.error && (
            <p className="text-xs text-destructive">
              {joinOrgMutation.error instanceof Error
                ? joinOrgMutation.error.message
                : "Failed to join organization"}
            </p>
          )}
          <button
            type="button"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors text-center"
            onClick={() => setCreatingNewOrg(true)}
          >
            Create a new organization instead
          </button>
        </div>
      </AuthSplitLayout>
    );
  }

  // Domain claimed but no auto-join → show info + option to create own org
  if (hasMatchingOrg) {
    const org = domainLookup.organization!;
    return (
      <AuthSplitLayout>
        <div className="grid gap-10">
          <OnboardingHeader
            title={`${org.name} is already set up`}
            description="This organization doesn't have auto-join enabled."
          />
          <div className="rounded-xl card-shadow bg-background dark:bg-input/30 p-4 flex items-center gap-4">
            <Avatar
              url={`https://www.google.com/s2/favicons?domain=${emailDomain}&sz=128`}
              fallback={org.name.charAt(0).toUpperCase()}
              shape="square"
              size="base"
              className="h-10 w-10 shrink-0"
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{org.name}</p>
              <p className="text-xs text-muted-foreground truncate">
                @{emailDomain}
              </p>
            </div>
            <span className="text-xs text-muted-foreground shrink-0">
              Ask admin for invitation
            </span>
          </div>
          <Button
            size="xl"
            className="w-full"
            onClick={() => setCreatingNewOrg(true)}
          >
            Create a new organization
          </Button>
        </div>
      </AuthSplitLayout>
    );
  }

  // Free domain (or generic email) → unified setup form
  return (
    <SetupForm
      isCorporateEmail={isCorporateEmail}
      emailDomain={emailDomain}
      domainLabel={domainLabel}
      defaultName={defaultName}
    />
  );
}

function SetupForm({
  isCorporateEmail,
  emailDomain,
  domainLabel,
  defaultName,
  allowDomainClaim = true,
  onBack,
}: {
  isCorporateEmail: boolean;
  emailDomain: string;
  domainLabel: string;
  defaultName: string;
  allowDomainClaim?: boolean;
  onBack?: () => void;
}) {
  const defaultLogo =
    isCorporateEmail && allowDomainClaim
      ? `https://www.google.com/s2/favicons?domain=${emailDomain}&sz=128`
      : null;
  const [orgName, setOrgName] = useState(defaultName);
  const [logo, setLogo] = useState<string | null>(defaultLogo);
  const [claimDomain, setClaimDomain] = useState(true);
  const [pendingRedirectSlug, setPendingRedirectSlug] = useState<string | null>(
    null,
  );

  const domainSetupMutation = useMutation({
    mutationFn: async (): Promise<DomainSetupResult> => {
      const res = await fetch("/api/auth/custom/domain-setup", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: orgName.trim() || undefined,
          logo: logo ?? undefined,
          claimDomain,
        }),
      });
      const data: DomainSetupResult = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to set up organization");
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data.slug) return;
      const stepsCount = SETUP_STEPS.filter(
        (s) => claimDomain || !s.claimOnly,
      ).length;
      const animationDuration = STEP_DELAY_MS * (stepsCount - 1) + 800;
      setPendingRedirectSlug(data.slug);
      setTimeout(() => {
        window.location.href = `/${data.slug}`;
      }, animationDuration);
    },
  });

  const createOrgMutation = useMutation({
    mutationFn: async () => {
      const name = orgName.trim();
      const slug = slugify(name);
      if (!slug) throw new Error("Invalid organization name");

      const result = await authClient.organization.create({
        name,
        slug,
        ...(logo ? { logo } : {}),
      });
      if (result?.error) {
        throw new Error(
          result.error.message || "Failed to create organization",
        );
      }
      window.location.href = `/${result?.data?.slug ?? slug}`;
    },
  });

  // Animated workflow only fires for corporate flow with brand extraction
  if (domainSetupMutation.isPending || pendingRedirectSlug) {
    return (
      <AuthSplitLayout>
        <SetupWorkflow
          orgName={orgName.trim() || domainLabel}
          domain={emailDomain}
          claimDomain={claimDomain}
          logoUrl={logo}
        />
      </AuthSplitLayout>
    );
  }

  const isSubmitting = createOrgMutation.isPending;
  const canSubmit = !!slugify(orgName.trim());
  const submissionError =
    domainSetupMutation.error || createOrgMutation.error || null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    if (isCorporateEmail && allowDomainClaim) {
      domainSetupMutation.mutate();
    } else {
      createOrgMutation.mutate();
    }
  };

  return (
    <AuthSplitLayout>
      <form onSubmit={handleSubmit} className="grid gap-10">
        <OnboardingHeader
          title="Welcome to deco"
          description="Set up your organization to get started"
        />

        <div className="rounded-xl card-shadow bg-background dark:bg-input/30 divide-y divide-border">
          <div className="flex items-center justify-between gap-4 p-4">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Organization avatar</p>
              <p className="text-xs text-muted-foreground">Optional</p>
            </div>
            <LogoUpload
              value={logo}
              fallback={(orgName.trim() || defaultName || "?")
                .charAt(0)
                .toUpperCase()}
              onChange={setLogo}
              disabled={isSubmitting || domainSetupMutation.isPending}
            />
          </div>

          <div className="flex items-center justify-between gap-4 p-4">
            <Label htmlFor="org-name" className="text-sm font-medium shrink-0">
              Organization name
            </Label>
            <Input
              id="org-name"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder={defaultName || "My Organization"}
              disabled={isSubmitting || domainSetupMutation.isPending}
              className="h-10 max-w-[220px]"
            />
          </div>

          {isCorporateEmail && allowDomainClaim && (
            <div className="flex items-center justify-between gap-4 p-4">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">
                  Allow @{emailDomain} sign-ups
                </p>
                <p className="text-xs text-muted-foreground">
                  Anyone with a verified @{emailDomain} email can join this org
                </p>
              </div>
              <Switch
                checked={claimDomain}
                onCheckedChange={setClaimDomain}
                disabled={isSubmitting || domainSetupMutation.isPending}
              />
            </div>
          )}
        </div>

        {submissionError && (
          <p className="text-xs text-destructive">
            {submissionError instanceof Error
              ? submissionError.message
              : "Failed to create organization"}
          </p>
        )}

        <Button
          type="submit"
          size="xl"
          className="w-full"
          disabled={!canSubmit || isSubmitting || domainSetupMutation.isPending}
        >
          {isSubmitting || domainSetupMutation.isPending ? (
            <span className="flex items-center gap-2">
              <Loading01 size={14} className="animate-spin" /> Creating...
            </span>
          ) : (
            "Continue"
          )}
        </Button>

        {onBack && (
          <button
            type="button"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors text-center"
            onClick={onBack}
          >
            See available organizations
          </button>
        )}
      </form>
    </AuthSplitLayout>
  );
}

function LogoUpload({
  value,
  fallback,
  onChange,
  disabled,
}: {
  value: string | null;
  fallback: string;
  onChange: (dataUrl: string | null) => void;
  disabled: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toast.error("Image must be smaller than 2MB");
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => toast.error("Failed to read image");
    reader.onloadend = () => {
      if (reader.result) onChange(reader.result as string);
      if (inputRef.current) inputRef.current.value = "";
    };
    reader.readAsDataURL(file);
  };

  return (
    <button
      type="button"
      onClick={() => inputRef.current?.click()}
      disabled={disabled}
      className="relative rounded-lg overflow-hidden ring-1 ring-border hover:ring-2 hover:ring-ring/40 transition-all disabled:opacity-50 group"
      aria-label="Upload organization logo"
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        onChange={handleFile}
        className="hidden"
        disabled={disabled}
      />
      <Avatar
        url={value ?? undefined}
        fallback={fallback}
        shape="square"
        size="base"
      />
      <span className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity">
        <Upload01 size={14} className="text-white" />
      </span>
    </button>
  );
}

// ============================================================================
// Setup Workflow — animated step progression
// ============================================================================

const SETUP_STEPS = [
  { icon: Building02, label: "Creating organization", claimOnly: false },
  { icon: Globe04, label: "Claiming email domain", claimOnly: true },
  { icon: Users03, label: "Enabling auto-join for your team", claimOnly: true },
  { icon: Palette, label: "Extracting brand context", claimOnly: false },
];

const STEP_DELAY_MS = 1500;

// Deco brand palette. Cycled per step so each completed badge gets a
// different brand color. Order matters — same indexes always pick the
// same colors so re-renders don't flicker.
const BRAND_PALETTE = [
  { bg: "var(--brand-green-light)", fg: "var(--brand-green-dark)" },
  { bg: "var(--brand-purple-light)", fg: "var(--brand-purple-dark)" },
  { bg: "var(--brand-yellow-light)", fg: "var(--brand-yellow-dark)" },
];

function SetupWorkflow({
  orgName,
  domain,
  claimDomain,
  logoUrl,
}: {
  orgName: string;
  domain: string;
  claimDomain: boolean;
  logoUrl?: string | null;
}) {
  // Filter steps based on whether the user is claiming the domain
  const steps = SETUP_STEPS.filter((s) => claimDomain || !s.claimOnly);

  const [activeStep, setActiveStep] = useState(0);
  const didSchedule = useRef(false);

  // Schedule step progression once — useRef guard prevents double-fire
  // in Strict Mode. Timers are short-lived and the component only unmounts
  // on redirect, so cleanup is not critical.
  if (!didSchedule.current) {
    didSchedule.current = true;
    for (let i = 1; i < steps.length; i++) {
      setTimeout(() => setActiveStep(i), STEP_DELAY_MS * i);
    }
  }

  return (
    <div className="grid gap-10">
      <OnboardingHeader
        title={`Setting up ${orgName}`}
        description={`Getting everything ready from ${domain}`}
        logoUrl={logoUrl ?? null}
        logoFallback={orgName.charAt(0).toUpperCase() || "?"}
      />

      <ul className="grid gap-5">
        {steps.map((step, i) => {
          const Icon = step.icon;
          const isActive = i === activeStep;
          const isDone = i < activeStep;
          const color = BRAND_PALETTE[i % BRAND_PALETTE.length]!;

          return (
            <li
              key={step.label}
              className="flex items-center gap-4 motion-safe:transition-opacity motion-safe:duration-300 motion-safe:ease-out"
              style={{ opacity: isDone || isActive ? 1 : 0.4 }}
            >
              <span
                className={cn(
                  "relative grid h-8 w-8 shrink-0 place-items-center rounded-lg",
                  "motion-safe:transition-colors motion-safe:duration-300",
                  !isDone &&
                    (isActive
                      ? "bg-muted text-foreground"
                      : "bg-muted text-muted-foreground"),
                )}
                style={
                  isDone
                    ? { backgroundColor: color.bg, color: color.fg }
                    : undefined
                }
              >
                <CheckCircle
                  size={16}
                  className={cn(
                    "absolute motion-safe:transition-all motion-safe:duration-300 motion-safe:ease-out",
                    isDone ? "scale-100 opacity-100" : "scale-75 opacity-0",
                  )}
                  aria-hidden="true"
                />
                <Loading01
                  size={16}
                  className={cn(
                    "absolute animate-spin",
                    "motion-safe:transition-opacity motion-safe:duration-200",
                    isActive ? "opacity-100" : "opacity-0",
                  )}
                  aria-hidden="true"
                />
                <Icon
                  size={16}
                  className={cn(
                    "absolute motion-safe:transition-opacity motion-safe:duration-200",
                    !isDone && !isActive ? "opacity-100" : "opacity-0",
                  )}
                  aria-hidden="true"
                />
              </span>
              <span
                className={cn(
                  "text-base leading-6 motion-safe:transition-colors motion-safe:duration-300",
                  isActive || isDone
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {step.label}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
