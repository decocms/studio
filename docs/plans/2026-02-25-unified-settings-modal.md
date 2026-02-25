# Unified Settings Modal Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the fragmented settings page + small dialog with one polished modal (sidebar nav + scrollable content panel), opened via `?settings=<section>` URL search param from any trigger.

**Architecture:** A `settings` optional search param is added to the `projectLayout` route. A `SettingsModal` is mounted inside `ProjectContextProvider` in `project-layout.tsx` — it reads the param and shows the active section. The old `/settings` route becomes a `beforeLoad` redirect. Both triggers (user menu + account switcher) navigate using the new param. Existing form components are reused as-is inside the new pages.

**Tech Stack:** TanStack Router (`useSearch`, `useNavigate`), `@deco/ui` Dialog, react-hook-form + Zod (reused), `authClient.useSession()`, `useProjectContext()`

---

### Task 1: Add `settings` search param to project layout route

**Files:**
- Modify: `apps/mesh/src/web/index.tsx`

**Step 1: Add validateSearch to `projectLayout`**

`z` is already imported. Find the `projectLayout` route definition (around line 149) and add `validateSearch`:

```typescript
const projectLayout = createRoute({
  getParentRoute: () => shellLayout,
  path: "/$org/$project",
  component: lazyRouteComponent(() => import("./layouts/project-layout.tsx")),
  validateSearch: z.object({
    settings: z.string().optional(),
  }),
});
```

**Step 2: Convert `projectSettingsRoute` to a redirect**

Replace the existing `projectSettingsRoute` (around line 174) with:

```typescript
const projectSettingsRoute = createRoute({
  getParentRoute: () => projectLayout,
  path: "/settings",
  beforeLoad: ({ params }) => {
    const isOrgAdmin = params.project === ORG_ADMIN_PROJECT_SLUG;
    throw redirect({
      to: "/$org/$project",
      params,
      search: { settings: isOrgAdmin ? "org.general" : "project.general" },
    });
  },
  component: () => null,
});
```

**Step 3: Run type check**

```bash
bun run check
```

Expected: No new errors.

**Step 4: Commit**

```bash
git add apps/mesh/src/web/index.tsx
git commit -m "feat(settings): add settings search param to project layout, convert /settings to redirect"
```

---

### Task 2: Create `useSettingsModal` hook

**Files:**
- Create: `apps/mesh/src/web/hooks/use-settings-modal.ts`

**Step 1: Write the hook**

```typescript
import { useNavigate, useSearch } from "@tanstack/react-router";

export type SettingsSection =
  | "account.profile"
  | "account.preferences"
  | "account.experimental"
  | "org.general"
  | "project.general"
  | "project.plugins"
  | "project.danger";

export function useSettingsModal() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { settings?: string };

  const activeSection = search.settings as SettingsSection | undefined;
  const isOpen = !!activeSection;

  const open = (section: SettingsSection) => {
    navigate({ search: (prev) => ({ ...prev, settings: section }) });
  };

  const close = () => {
    navigate({
      search: (prev) => {
        const { settings: _s, ...rest } = prev as Record<string, unknown>;
        return rest as Record<string, string>;
      },
    });
  };

  return {
    isOpen,
    activeSection: activeSection ?? "account.preferences",
    open,
    close,
  };
}
```

**Step 2: Commit**

```bash
git add apps/mesh/src/web/hooks/use-settings-modal.ts
git commit -m "feat(settings): add useSettingsModal hook"
```

---

### Task 3: Create settings modal sidebar

**Files:**
- Create: `apps/mesh/src/web/components/settings-modal/sidebar.tsx`

**Step 1: Write the sidebar**

```typescript
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  Bell01,
  Building02,
  FlaskConical,
  Settings01,
  Trash01,
  Zap,
} from "@untitledui/icons";
import { authClient } from "@/web/lib/auth-client";
import { useProjectContext, ORG_ADMIN_PROJECT_SLUG } from "@decocms/mesh-sdk";
import type { SettingsSection } from "@/web/hooks/use-settings-modal";

interface SidebarItem {
  key: SettingsSection;
  label: string;
  icon: React.ReactNode;
}

interface SidebarGroup {
  label: string;
  items: SidebarItem[];
}

interface SettingsSidebarProps {
  activeSection: SettingsSection;
  onNavigate: (section: SettingsSection) => void;
}

export function SettingsSidebar({
  activeSection,
  onNavigate,
}: SettingsSidebarProps) {
  const { data: session } = authClient.useSession();
  const { project } = useProjectContext();
  const isOrgAdmin = project.slug === ORG_ADMIN_PROJECT_SLUG;

  const user = session?.user;
  const userImage = (user as { image?: string } | undefined)?.image;

  const groups: SidebarGroup[] = [
    {
      label: "Account",
      items: [
        {
          key: "account.profile",
          label: user?.name ?? "Profile",
          icon: (
            <Avatar
              url={userImage}
              fallback={user?.name ?? "U"}
              shape="circle"
              size="2xs"
              className="size-4 shrink-0"
            />
          ),
        },
        {
          key: "account.preferences",
          label: "Preferences",
          icon: <Settings01 size={14} />,
        },
        {
          key: "account.experimental",
          label: "Experimental",
          icon: <FlaskConical size={14} />,
        },
      ],
    },
    {
      label: "Organization",
      items: [
        {
          key: "org.general",
          label: "General",
          icon: <Building02 size={14} />,
        },
      ],
    },
    ...(!isOrgAdmin
      ? [
          {
            label: "Project",
            items: [
              {
                key: "project.general" as SettingsSection,
                label: "General",
                icon: <Settings01 size={14} />,
              },
              {
                key: "project.plugins" as SettingsSection,
                label: "Plugins",
                icon: <Zap size={14} />,
              },
              {
                key: "project.danger" as SettingsSection,
                label: "Danger Zone",
                icon: <Trash01 size={14} />,
              },
            ],
          },
        ]
      : []),
  ];

  return (
    <div className="w-52 shrink-0 border-r border-border bg-sidebar/50 overflow-y-auto py-3 flex flex-col gap-1">
      {groups.map((group) => (
        <div key={group.label} className="flex flex-col gap-0.5 px-2">
          <p className="px-2 py-1.5 text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wider">
            {group.label}
          </p>
          {group.items.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => onNavigate(item.key)}
              className={cn(
                "flex items-center gap-2.5 px-2 py-1.5 rounded-md text-sm text-left w-full transition-colors",
                activeSection === item.key
                  ? "bg-accent text-accent-foreground font-medium"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <span className="shrink-0">{item.icon}</span>
              <span className="truncate">{item.label}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add apps/mesh/src/web/components/settings-modal/sidebar.tsx
git commit -m "feat(settings): add settings modal sidebar component"
```

---

### Task 4: Create settings pages — Account

**Files:**
- Create: `apps/mesh/src/web/components/settings-modal/pages/account-profile.tsx`
- Create: `apps/mesh/src/web/components/settings-modal/pages/account-preferences.tsx`
- Create: `apps/mesh/src/web/components/settings-modal/pages/account-experimental.tsx`

**Step 1: Create `account-profile.tsx`**

```typescript
import { useState } from "react";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { Check, Copy01 } from "@untitledui/icons";
import { authClient } from "@/web/lib/auth-client";

export function AccountProfilePage() {
  const { data: session } = authClient.useSession();
  const [copied, setCopied] = useState(false);

  const user = session?.user;
  const userImage = (user as { image?: string } | undefined)?.image;

  const handleCopyUserId = () => {
    if (!user?.id) return;
    navigator.clipboard.writeText(user.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h2 className="text-base font-semibold text-foreground">Profile</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Your account identity on this workspace.
        </p>
      </div>

      <div className="flex items-center gap-4">
        <Avatar
          url={userImage}
          fallback={user?.name ?? "U"}
          shape="circle"
          size="xl"
          className="size-16 shrink-0"
        />
        <div className="flex flex-col gap-1 min-w-0">
          <span className="text-sm font-semibold text-foreground truncate">
            {user?.name ?? "User"}
          </span>
          <span className="text-sm text-muted-foreground truncate">
            {user?.email}
          </span>
        </div>
      </div>

      <div className="border-t border-border pt-6 flex flex-col gap-2">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          User ID
        </p>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleCopyUserId}
                className="group flex items-center gap-2 w-fit text-muted-foreground hover:text-foreground transition-colors"
              >
                <span className="font-mono text-xs">{user?.id}</span>
                {copied ? (
                  <Check size={14} className="text-green-600 shrink-0" />
                ) : (
                  <Copy01
                    size={14}
                    className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                  />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p className="text-xs">Copy user ID</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  );
}
```

**Step 2: Create `account-preferences.tsx`**

Note: The preferences logic (toggles, select) is moved verbatim from `user-settings-dialog.tsx`. The visual change is from bordered cards → clean rows separated by dividers.

```typescript
import { Switch } from "@deco/ui/components/switch.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { Bell01, Code01 } from "@untitledui/icons";
import { usePreferences } from "@/web/hooks/use-preferences.ts";
import { toast } from "@deco/ui/components/sonner.js";

function SettingRow({
  icon,
  label,
  description,
  control,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  control: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <div
      className="flex items-center justify-between gap-6 py-4 border-b border-border last:border-0"
      onClick={disabled ? undefined : onClick}
      role={onClick ? "button" : undefined}
      style={{ cursor: onClick && !disabled ? "pointer" : undefined }}
    >
      <div className="flex items-start gap-3 min-w-0 flex-1">
        <span className="text-muted-foreground mt-0.5 shrink-0">{icon}</span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
            {description}
          </p>
        </div>
      </div>
      <div onClick={(e) => e.stopPropagation()} className="shrink-0">
        {control}
      </div>
    </div>
  );
}

export function AccountPreferencesPage() {
  const [preferences, setPreferences] = usePreferences();

  const handleNotificationsChange = async (checked: boolean) => {
    if (checked) {
      const result = await Notification.requestPermission();
      if (result !== "granted") {
        toast.error(
          "Notifications denied. Please enable them in your browser settings.",
        );
        setPreferences((prev) => ({ ...prev, enableNotifications: false }));
        return;
      }
    }
    setPreferences((prev) => ({ ...prev, enableNotifications: checked }));
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-base font-semibold text-foreground">Preferences</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Customize how the app works for you.
        </p>
      </div>

      <div className="flex flex-col">
        <SettingRow
          icon={<Code01 size={16} />}
          label="Developer Mode"
          description="Show technical details like JSON input/output for tool calls."
          onClick={() =>
            setPreferences((prev) => ({ ...prev, devMode: !prev.devMode }))
          }
          control={
            <Switch
              checked={preferences.devMode}
              onCheckedChange={(checked) =>
                setPreferences((prev) => ({ ...prev, devMode: checked }))
              }
            />
          }
        />
        <SettingRow
          icon={<Bell01 size={16} />}
          label="Notifications"
          description="Play a sound and show a notification when chat messages complete while the app is unfocused."
          disabled={typeof Notification === "undefined"}
          onClick={() =>
            handleNotificationsChange(!preferences.enableNotifications)
          }
          control={
            <Switch
              disabled={typeof Notification === "undefined"}
              checked={preferences.enableNotifications}
              onCheckedChange={handleNotificationsChange}
            />
          }
        />
      </div>

      <div className="flex flex-col gap-2 pt-2 border-t border-border">
        <div>
          <p className="text-sm font-medium text-foreground">Tool Approval</p>
          <p className="text-xs text-muted-foreground mt-1">
            Choose when to require approval before tools execute.
          </p>
        </div>
        <Select
          value={preferences.toolApprovalLevel}
          onValueChange={(value) =>
            setPreferences((prev) => ({
              ...prev,
              toolApprovalLevel: value as "none" | "readonly" | "yolo",
            }))
          }
        >
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">None</span>
                <span className="text-xs text-muted-foreground">
                  Require approval for all tool calls
                </span>
              </div>
            </SelectItem>
            <SelectItem value="readonly">
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">Read-only</span>
                <span className="text-xs text-muted-foreground">
                  Auto-approve read-only tools
                </span>
              </div>
            </SelectItem>
            <SelectItem value="yolo">
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">YOLO</span>
                <span className="text-xs text-muted-foreground">
                  Execute all tools without approval
                </span>
              </div>
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
```

**Step 3: Create `account-experimental.tsx`**

```typescript
import { Switch } from "@deco/ui/components/switch.tsx";
import { CheckDone01, Folder } from "@untitledui/icons";
import { usePreferences } from "@/web/hooks/use-preferences.ts";

function ExperimentalRow({
  icon,
  label,
  description,
  checked,
  onCheckedChange,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  return (
    <div
      className="flex items-center justify-between gap-6 py-4 border-b border-border last:border-0 cursor-pointer"
      onClick={() => onCheckedChange(!checked)}
    >
      <div className="flex items-start gap-3 min-w-0 flex-1">
        <span className="text-muted-foreground mt-0.5 shrink-0">{icon}</span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
            {description}
          </p>
        </div>
      </div>
      <div onClick={(e) => e.stopPropagation()} className="shrink-0">
        <Switch checked={checked} onCheckedChange={onCheckedChange} />
      </div>
    </div>
  );
}

export function AccountExperimentalPage() {
  const [preferences, setPreferences] = usePreferences();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-base font-semibold text-foreground">Experimental</h2>
        <p className="text-sm text-muted-foreground mt-1">
          These features are unstable and may change or stop working at any
          time.
        </p>
      </div>

      <div className="flex flex-col rounded-lg border border-amber-500/20 bg-amber-500/5 px-4">
        <ExperimentalRow
          icon={<Folder size={16} />}
          label="Projects"
          description="Enable the projects feature in the sidebar."
          checked={preferences.experimental_projects}
          onCheckedChange={(checked) =>
            setPreferences((prev) => ({
              ...prev,
              experimental_projects: checked,
            }))
          }
        />
        <ExperimentalRow
          icon={<CheckDone01 size={16} />}
          label="Tasks"
          description="Enable the tasks feature in the sidebar."
          checked={preferences.experimental_tasks}
          onCheckedChange={(checked) =>
            setPreferences((prev) => ({
              ...prev,
              experimental_tasks: checked,
            }))
          }
        />
      </div>
    </div>
  );
}
```

**Step 4: Commit**

```bash
git add apps/mesh/src/web/components/settings-modal/pages/account-profile.tsx \
        apps/mesh/src/web/components/settings-modal/pages/account-preferences.tsx \
        apps/mesh/src/web/components/settings-modal/pages/account-experimental.tsx
git commit -m "feat(settings): add account settings pages (profile, preferences, experimental)"
```

---

### Task 5: Create settings pages — Organization and Project

**Files:**
- Create: `apps/mesh/src/web/components/settings-modal/pages/org-general.tsx`
- Create: `apps/mesh/src/web/components/settings-modal/pages/project-general.tsx`
- Create: `apps/mesh/src/web/components/settings-modal/pages/project-plugins.tsx`
- Create: `apps/mesh/src/web/components/settings-modal/pages/project-danger.tsx`

**Step 1: Create `org-general.tsx`**

Thin wrapper around the existing `OrganizationForm`.

```typescript
import { OrganizationForm } from "@/web/components/settings/organization-form";

export function OrgGeneralPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-base font-semibold text-foreground">
          Organization
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Update your organization's name, slug, and logo.
        </p>
      </div>
      <OrganizationForm />
    </div>
  );
}
```

**Step 2: Create `project-general.tsx`**

```typescript
import { ProjectGeneralForm } from "@/web/components/settings/project-general-form";

export function ProjectGeneralPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-base font-semibold text-foreground">General</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Basic project information.
        </p>
      </div>
      <ProjectGeneralForm />
    </div>
  );
}
```

**Step 3: Create `project-plugins.tsx`**

```typescript
import { ProjectPluginsForm } from "@/web/components/settings/project-plugins-form";

export function ProjectPluginsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-base font-semibold text-foreground">Plugins</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Manage which plugins are enabled and configure their connections.
        </p>
      </div>
      <ProjectPluginsForm />
    </div>
  );
}
```

**Step 4: Create `project-danger.tsx`**

```typescript
import { DangerZone } from "@/web/components/settings/danger-zone";

export function ProjectDangerPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-base font-semibold text-foreground">Danger Zone</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Irreversible and destructive actions.
        </p>
      </div>
      <DangerZone />
    </div>
  );
}
```

**Step 5: Commit**

```bash
git add apps/mesh/src/web/components/settings-modal/pages/org-general.tsx \
        apps/mesh/src/web/components/settings-modal/pages/project-general.tsx \
        apps/mesh/src/web/components/settings-modal/pages/project-plugins.tsx \
        apps/mesh/src/web/components/settings-modal/pages/project-danger.tsx
git commit -m "feat(settings): add org and project settings pages"
```

---

### Task 6: Create the SettingsModal main component

**Files:**
- Create: `apps/mesh/src/web/components/settings-modal/index.tsx`

**Step 1: Write the modal**

```typescript
import {
  Dialog,
  DialogContent,
} from "@deco/ui/components/dialog.tsx";
import { X } from "@untitledui/icons";
import { Suspense } from "react";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { useSettingsModal, type SettingsSection } from "@/web/hooks/use-settings-modal";
import { SettingsSidebar } from "./sidebar";
import { AccountProfilePage } from "./pages/account-profile";
import { AccountPreferencesPage } from "./pages/account-preferences";
import { AccountExperimentalPage } from "./pages/account-experimental";
import { OrgGeneralPage } from "./pages/org-general";
import { ProjectGeneralPage } from "./pages/project-general";
import { ProjectPluginsPage } from "./pages/project-plugins";
import { ProjectDangerPage } from "./pages/project-danger";

function SettingsContent({ section }: { section: SettingsSection }) {
  switch (section) {
    case "account.profile":
      return <AccountProfilePage />;
    case "account.preferences":
      return <AccountPreferencesPage />;
    case "account.experimental":
      return <AccountExperimentalPage />;
    case "org.general":
      return <OrgGeneralPage />;
    case "project.general":
      return <ProjectGeneralPage />;
    case "project.plugins":
      return <ProjectPluginsPage />;
    case "project.danger":
      return <ProjectDangerPage />;
    default:
      return <AccountPreferencesPage />;
  }
}

export function SettingsModal() {
  const { isOpen, activeSection, open, close } = useSettingsModal();

  return (
    <Dialog open={isOpen} onOpenChange={(v) => !v && close()}>
      <DialogContent
        className="sm:max-w-[900px] max-h-[85vh] p-0 overflow-hidden flex flex-col gap-0"
        closeButtonClassName="hidden"
      >
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Left sidebar */}
          <Suspense fallback={<div className="w-52 shrink-0 border-r border-border" />}>
            <SettingsSidebar
              activeSection={activeSection}
              onNavigate={open}
            />
          </Suspense>

          {/* Right content */}
          <div className="flex-1 overflow-y-auto p-8 min-w-0 relative">
            {/* Close button */}
            <button
              type="button"
              onClick={close}
              className="absolute top-4 right-4 rounded-md p-1 opacity-70 hover:opacity-100 transition-opacity focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <X size={16} />
              <span className="sr-only">Close</span>
            </button>

            <Suspense
              fallback={
                <div className="flex flex-col gap-4 pt-2">
                  <Skeleton className="h-6 w-48" />
                  <Skeleton className="h-4 w-80" />
                  <div className="mt-4 flex flex-col gap-3">
                    <Skeleton className="h-12 w-full" />
                    <Skeleton className="h-12 w-full" />
                  </div>
                </div>
              }
            >
              <SettingsContent section={activeSection} />
            </Suspense>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

**Step 2: Commit**

```bash
git add apps/mesh/src/web/components/settings-modal/index.tsx
git commit -m "feat(settings): add SettingsModal main component"
```

---

### Task 7: Mount SettingsModal in project-layout.tsx

**Files:**
- Modify: `apps/mesh/src/web/layouts/project-layout.tsx`

**Step 1: Import and render SettingsModal**

Add to the imports at the top of the file:

```typescript
import { SettingsModal } from "@/web/components/settings-modal/index";
```

In `ProjectLayoutContent`, render `<SettingsModal />` inside `ProjectContextProvider`, after the `Suspense` wrapping `Outlet`:

```typescript
return (
  <ProjectContextProvider org={org} project={enhancedProject}>
    <Suspense fallback={<SplashScreen />}>
      <Outlet />
    </Suspense>
    <SettingsModal />
  </ProjectContextProvider>
);
```

**Step 2: Run type check**

```bash
bun run check
```

Expected: No errors.

**Step 3: Commit**

```bash
git add apps/mesh/src/web/layouts/project-layout.tsx
git commit -m "feat(settings): mount SettingsModal in project layout"
```

---

### Task 8: Update user-menu.tsx

**Files:**
- Modify: `apps/mesh/src/web/components/user-menu.tsx`

**Step 1: Replace dialog state with hook navigation**

Remove these lines from `MeshUserMenuBase`:
```typescript
// REMOVE these:
const [settingsOpen, setSettingsOpen] = useState(false);
import { UserSettingsDialog } from "@/web/components/user-settings-dialog.tsx";
```

Add at the top of `MeshUserMenuBase`:
```typescript
import { useSettingsModal } from "@/web/hooks/use-settings-modal";
// Inside component:
const { open: openSettings } = useSettingsModal();
```

Change the Settings `DropdownMenuItem` onClick:
```typescript
// BEFORE:
onClick={() => setSettingsOpen(true)}

// AFTER:
onClick={() => openSettings("account.preferences")}
```

Remove the `UserSettingsDialog` JSX from the return (the fragment at the bottom of `MeshUserMenuBase`):
```typescript
// REMOVE:
{settingsOpen && (
  <UserSettingsDialog
    open={settingsOpen}
    onOpenChange={setSettingsOpen}
    user={user}
    userImage={userImage}
  />
)}
```

**Step 2: Run type check + format**

```bash
bun run check && bun run fmt
```

**Step 3: Commit**

```bash
git add apps/mesh/src/web/components/user-menu.tsx
git commit -m "feat(settings): update user menu to open unified settings modal"
```

---

### Task 9: Update account-switcher handleSettings

**Files:**
- Modify: `apps/mesh/src/web/components/sidebar/header/account-switcher/index.tsx`

**Step 1: Replace `handleSettings` navigation**

Find `handleSettings` (around line 108):

```typescript
// BEFORE:
const handleSettings = () => {
  if (!orgParam || !projectParam) return;
  navigate({
    to: "/$org/$project/settings",
    params: { org: orgParam, project: projectParam },
  });
};

// AFTER:
const handleSettings = () => {
  if (!orgParam || !projectParam) return;
  const isOrgAdmin = projectParam === ORG_ADMIN_PROJECT_SLUG;
  navigate({
    to: "/$org/$project",
    params: { org: orgParam, project: projectParam },
    search: (prev) => ({
      ...prev,
      settings: isOrgAdmin ? "org.general" : "project.general",
    }),
  });
};
```

**Step 2: Run type check + format**

```bash
bun run check && bun run fmt
```

**Step 3: Commit**

```bash
git add apps/mesh/src/web/components/sidebar/header/account-switcher/index.tsx
git commit -m "feat(settings): update account switcher to open unified settings modal"
```

---

### Task 10: Delete old user-settings-dialog.tsx

**Files:**
- Delete: `apps/mesh/src/web/components/user-settings-dialog.tsx`

**Step 1: Confirm no remaining imports**

```bash
grep -r "user-settings-dialog" apps/mesh/src/web/
```

Expected: No output (zero matches).

**Step 2: Delete the file**

```bash
rm apps/mesh/src/web/components/user-settings-dialog.tsx
```

**Step 3: Run type check to confirm clean**

```bash
bun run check
```

Expected: No errors.

**Step 4: Run format**

```bash
bun run fmt
```

**Step 5: Commit**

```bash
git add -A
git commit -m "feat(settings): remove old user-settings-dialog, now absorbed into settings modal"
```

---

### Task 11: Final smoke test + cleanup commit

**Step 1: Run all checks**

```bash
bun run check && bun run lint && bun run fmt:check
```

Expected: All pass.

**Step 2: Run tests**

```bash
bun test
```

Expected: All pass (no regressions).

**Step 3: Manual verification checklist**

Open the app and verify:
- [ ] Clicking "Settings" in user menu opens modal at Account > Preferences
- [ ] Clicking "Settings" in account switcher (project) opens modal at Project > General
- [ ] Clicking "Settings" in account switcher (org-admin) opens modal at Organization > General
- [ ] Navigating directly to `/$org/$project/settings` redirects and opens modal at correct section
- [ ] Sidebar items switch panels without closing the modal
- [ ] Close button dismisses the modal and returns to the previous page/state
- [ ] Project group is hidden when in org-admin context
- [ ] Preferences (dev mode, notifications, tool approval) still function
- [ ] Experimental toggles still function
- [ ] Organization form saves correctly
- [ ] Project general form saves correctly
- [ ] Plugins form saves correctly
- [ ] Danger zone delete still works

**Step 4: Final commit**

```bash
git commit --allow-empty -m "feat(settings): unified settings modal complete"
```
