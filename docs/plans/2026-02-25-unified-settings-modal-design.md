# Unified Settings Modal Design

**Date:** 2026-02-25
**Status:** Approved

## Problem

Settings are split across two separate UIs:
- A full-page route at `/$org/$project/settings` (Organization, General, Plugins, Danger Zone)
- A small 480px dialog from the user menu (Preferences, Tool Approval, Experimental)

Users have to navigate to different places depending on what they want to change, and neither UI is particularly polished.

## Goal

One unified settings modal with a sidebar, opened from any trigger point (account switcher, user menu, future entry points), with URL deep-linking so panels are shareable and bookmarkable.

## Design

### Layout

Wide modal (~900×600px, max 90vh). Fixed 220px left sidebar, scrollable right content panel. Dark backdrop, close button top-right. Notion-style.

### Sidebar Structure

```
Account
  ├── [avatar] You           (profile display item)
  ├── Preferences            (dev mode, notifications, tool approval)
  └── Experimental           (feature flags)

Organization
  └── General                (org name, slug, logo)

Project                      [hidden in org-admin context]
  ├── General                (project name, description)
  ├── Plugins                (enabled plugins + connection selectors)
  └── Danger Zone            (delete project)
```

### URL / Routing Strategy

Add optional `settings` search param to the **project layout** route (not a new sub-route). The modal is mounted in the layout and visible when the param is set.

URL format: `?settings=<group>.<section>`

| Section | URL param |
|---------|-----------|
| Account > Profile | `?settings=account.profile` |
| Account > Preferences | `?settings=account.preferences` |
| Account > Experimental | `?settings=account.experimental` |
| Organization > General | `?settings=org.general` |
| Project > General | `?settings=project.general` |
| Project > Plugins | `?settings=project.plugins` |
| Project > Danger Zone | `?settings=project.danger` |

The old `/$org/$project/settings` route becomes a redirect that sets `?settings=project.general` (or `?settings=org.general` for org-admin projects).

### Per-panel Content

**Account > Profile**
- Large avatar, name, email (display only)
- Copy user ID button
- App version

**Account > Preferences**
- Each setting as a full-width row: title + description left, control right
- Developer Mode toggle
- Notifications toggle

**Account > Preferences (Tool Approval section)**
- Tool Approval select (None / Read-only / YOLO) — inline in Preferences panel or its own row

**Account > Experimental**
- Warning banner: "Experimental features may break at any time"
- Projects toggle row
- Tasks toggle row

**Organization > General**
- Organization name input
- Organization slug input
- Logo upload
- Save / Cancel buttons (only shown when dirty)

**Project > General**
- Project name input
- Project slug (read-only)
- Project description textarea
- Save / Cancel buttons (only shown when dirty)

**Project > Plugins**
- Each plugin as a row: toggle + inline connection selector when enabled

**Project > Danger Zone**
- Destructive section with red tint/border
- Delete project button → triggers existing AlertDialog confirmation

### Row Pattern (Preference rows)

Each setting row in preferences/experimental panels follows:

```
┌─────────────────────────────────────────────────────┐
│ Setting Name                          [toggle/select] │
│ Brief description of what this does                  │
└─────────────────────────────────────────────────────┘
```

Rows separated by thin dividers (`border-b border-border`). No bordered card wrappers.

## What Changes

### Removed
- `user-settings-dialog.tsx` — absorbed into the modal
- `/$org/$project/settings` as a standalone page route — becomes a redirect

### Updated
- Account switcher dropdown: settings item navigates with `?settings=project.general` (or `?settings=org.general`)
- User menu dropdown: settings item navigates with `?settings=account.preferences`
- Project layout route: add `settings` search param validation

### Created
- `components/settings-modal/index.tsx` — main modal shell
- `components/settings-modal/sidebar.tsx` — left sidebar with groups and items
- `components/settings-modal/pages/account-profile.tsx`
- `components/settings-modal/pages/account-preferences.tsx`
- `components/settings-modal/pages/account-experimental.tsx`
- `components/settings-modal/pages/org-general.tsx`
- `components/settings-modal/pages/project-general.tsx`
- `components/settings-modal/pages/project-plugins.tsx`
- `components/settings-modal/pages/project-danger.tsx`

## Implementation Notes

- Use TanStack Router `useNavigate` + `useSearch` to read/set the `settings` param
- Modal opens/closes by setting/removing the `settings` param (preserves the current route)
- No new route definitions needed beyond adding the search param to the project layout
- All existing form logic (react-hook-form + mutations) is reused verbatim in the new panels
- `DangerZone` component reused as-is inside the danger panel
