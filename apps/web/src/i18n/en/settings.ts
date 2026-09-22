export const settings = {
  "settings.title": "Profile & Preferences",
  "settings.nav.organization": "Organization",
  "settings.nav.build": "Build",
  "settings.nav.manage": "Manage",
  "settings.nav.general": "General",
  "settings.nav.connect": "Connect",
  "settings.nav.aiProviders": "AI Providers",
  "settings.nav.secrets": "Secrets",
  "settings.nav.billing": "Billing & AI",
  "settings.nav.buckets": "Buckets",
  "settings.nav.syncedRepos": "Synced repos",
  "settings.nav.repositories": "Repositories",
  "settings.nav.storage": "Storage",
  "settings.nav.advanced": "Advanced",
  "settings.subnav.ariaLabel": "Settings sections",
  "settings.subnav.infrastructure": "Infrastructure",
  "settings.nav.tasks": "Board",
  "settings.jira.sectionTitle": "Jira integration",
  "settings.jira.connectTitle": "Connect Jira",
  "settings.jira.connectDescription":
    "Use a Jira Cloud site and an API token, ideally from a service account that can see the project.",
  "settings.jira.siteLabel": "Jira site",
  "settings.jira.sitePlaceholder": "yourcompany.atlassian.net",
  "settings.jira.emailLabel": "Atlassian account email",
  "settings.jira.emailPlaceholder": "you@company.com",
  "settings.jira.tokenLabel": "API token",
  "settings.jira.tokenPlaceholder": "Paste your token",
  "settings.jira.connect": "Connect",
  "settings.jira.connecting": "Connecting…",
  "settings.jira.connected": "Jira connected",
  "settings.jira.connectFailed": "Could not connect to Jira",
  "settings.jira.disconnect": "Disconnect",
  "settings.jira.disconnected": "Jira disconnected",
  "settings.jira.disconnectTitle": "Disconnect Jira?",
  "settings.jira.disconnectDescription":
    "The sync stops and the credentials are deleted. Cards already on the board are kept — they just stop updating.",
  "settings.jira.cancel": "Cancel",
  "settings.jira.boardLabel": "Jira board",
  "settings.jira.boardDescription":
    "The board Studio watches — a card entering one of its columns is what sets the integration off.",
  "settings.jira.boardPlaceholder": "Select a board",
  "settings.jira.boardSearchPlaceholder": "Search boards…",
  "settings.jira.noBoardsMatch": "No board matches that search",
  "settings.jira.loadingBoards": "Loading boards…",
  "settings.jira.enabledLabel": "Integration enabled",
  "settings.jira.enabledDescription":
    "While off, cards moving on the board are ignored.",
  "settings.jira.enableRequirements":
    "Pick a board before enabling the integration",
  "settings.jira.saveFailed": "Could not save the Jira settings",
  "settings.jira.createTokenLink": "Create an API token",
  "settings.jira.webhookTitle": "Instant updates (webhook)",
  "settings.jira.webhookDescription":
    "Optional. Without it, an issue entering an automated status is picked up on the next 10-minute check; with it, the run starts within seconds.",
  "settings.jira.webhookCopy": "Copy",
  "settings.jira.webhookCopied": "Webhook URL copied",
  "settings.jira.webhookStep1":
    "In Jira, open Settings (gear icon) → System → Webhooks. This requires a Jira admin.",
  "settings.jira.webhookStep2":
    "Click “Create a webhook” and paste the URL above.",
  "settings.jira.webhookStep3":
    "Under Events, check Issue: created and Issue: updated.",
  "settings.jira.webhookStep4":
    "Optionally scope it with a JQL filter, e.g. project = <your project key>.",
  "settings.jira.webhookStep5":
    "Save. An issue entering an automated status now starts its run within seconds.",
  "settings.jira.automationsLabel": "Run the agent when an issue enters…",
  "settings.jira.automationsDescription":
    "When an issue enters one of these statuses, Studio starts an agent run on it. The agent reads the issue and updates it in Jira; nothing is copied to the board.",
  "settings.jira.addAutomation": "Add automation",
  "settings.jira.automationOn": "Automation on",
  "settings.jira.promptPlaceholder": "Review the issue and leave a comment…",
  "settings.jira.promptHelp":
    "This is the whole instruction the run gets — there is no default. Type “/” to insert a skill (jira-execute to build, jira-review to review); its text is pasted in for you to keep, edit or cut. The issue's description, comments, links and attachments are always included.",
  "settings.jira.promptSave": "Save",
  "settings.jira.promptDiscard": "Discard",
  "settings.jira.removeAriaLabel": "Stop running the agent on {status}",
  "settings.jira.noColumnsYet": "No columns on this board yet",
  "settings.jira.columnsFailed": "Could not load this board's columns",
  "settings.jira.testRunLabel": "Run it by hand",
  "settings.jira.testRunDescription":
    "Run the agent on one issue or a batch now, without a rule and without enabling the integration \u2014 so you can see what a prompt does before it runs on every issue entering a status.",
  "settings.jira.issueKeysPlaceholder":
    "ABC-123, or a link — one per line, or comma-separated",
  "settings.jira.issueKeysCount": "{count} issue(s)",
  "settings.jira.issueKeysUnreadable": "could not read: {items}",
  "settings.jira.testRunIssueAriaLabel": "Jira issue key or link",
  "settings.jira.testRun": "Run agent {count}",
  "settings.jira.testRunRunning": "Starting\u2026",
  "settings.jira.testRunStarted": "Started on",
  "settings.jira.testRunFailed": "Could not start the run",
  "settings.jira.testRunHelp":
    "This is a real run: the agent reads the actual issue, comments on it, and may move it. Running it again stops whatever run is still working that issue. Type “/” to insert the same skill the column rule would use.",
  "settings.jira.continuePr":
    "Continue the pull request the issue already carries (a re-run after a review asked for changes)",
  "settings.jira.continuePrRuleHelp":
    "Checked on every card that enters this status: one that already carries an open pull request continues it, one with none starts fresh. Leave it off on a review status.",
  "settings.jira.together":
    "One run for all of them — the agent sees every issue and works them as a batch, instead of one run per issue",
  "settings.jira.togetherStarted": "Started one run on",
  "settings.jira.testRunWatch": "Watch runs in Monitor",
  "settings.syncedRepos.pageDescription":
    "Git repositories mirrored into read-only library folders and kept in sync every few minutes. Great for a shared skills repo.",
  "settings.syncedRepos.addRepo": "Add repo",
  "settings.syncedRepos.cancel": "Cancel",
  "settings.syncedRepos.create": "Create",
  "settings.syncedRepos.creating": "Creating…",
  "settings.syncedRepos.created":
    'Sync created — syncing into "{volume}" in the background',
  "settings.syncedRepos.emptyTitle": "No synced repos yet",
  "settings.syncedRepos.emptyDescription":
    "Pick a repository and it will appear in the library as a read-only folder, kept in sync automatically.",
  "settings.syncedRepos.failed": "Something went wrong",
  "settings.syncedRepos.nameDialogDescription":
    "{repo} will be kept in sync into this read-only library folder.",
  "settings.syncedRepos.nameDialogTitle": "Name the synced folder",
  "settings.syncedRepos.namePlaceholder": "folder-name",
  "settings.syncedRepos.pickerTitle": "Sync a repo into the library",
  "settings.syncedRepos.remove": "Stop syncing",
  "settings.syncedRepos.removeDescription":
    "The already-synced files stay in the library; only the sync stops. You can delete the folder afterwards if you don't need it.",
  "settings.syncedRepos.removeTitle": 'Stop syncing "{volume}"?',
  "settings.syncedRepos.removed": "Sync removed",
  "settings.syncedRepos.rowSubtitle": "Library folder: {volume}",
  "settings.repositories.pageDescription":
    "Connect your git provider accounts and link the repositories this organization works with.",
  "settings.repositories.accountsTitle": "Connected accounts",
  "settings.repositories.accountsDescription":
    "Accounts Studio uses to read your repositories and push changes on your behalf.",
  "settings.repositories.accountsEmptyTitle": "No accounts connected",
  "settings.repositories.accountsEmptyDescription":
    "Connect a GitHub, GitLab or Bitbucket account to browse your repositories and link private ones.",
  "settings.repositories.noProvidersTitle": "No git provider configured",
  "settings.repositories.noProvidersDescription":
    "Signing in with GitHub, GitLab or Bitbucket needs provider credentials an administrator configures for this deployment. You can still connect a GitLab or Bitbucket account with an access token.",
  "settings.repositories.githubUnavailable":
    "Ask an administrator to enable GitHub.",
  "settings.repositories.connectGithubCli": "Connect with GitHub CLI",
  "settings.repositories.githubCliHint":
    "Use your local gh login to browse and import repositories.",
  "settings.repositories.authKindGithubCli": "GitHub CLI",
  "settings.repositories.addGithubAccount":
    "Add GitHub account or organization",
  "settings.repositories.githubSelectTitle": "Select repositories",
  "settings.repositories.githubSelectedShareHint":
    "Members with repository permissions in {organization} can use the repositories you authorize here.",
  "settings.repositories.githubSelectHint":
    "Choose up to 500 repositories for this workspace.",
  "settings.repositories.githubPreselectedHint":
    "Previously authorized or linked repositories are already selected when you have permission to authorize them. Review the selection before saving.",
  "settings.repositories.githubReplaceHint":
    "Saving replaces this account’s existing workspace access with your selection. Removed repositories stop receiving new credentials. Previously issued credentials may work until they expire.",
  "settings.repositories.githubFilterRepos": "Search repositories",
  "settings.repositories.githubNoRepos":
    "No repositories available to authorize.",
  "settings.repositories.githubSearchNoMatches":
    "No repositories match your search.",
  "settings.repositories.githubAccessChanged":
    "Someone changed this account’s access. Go back and review the repositories again before saving.",
  "settings.repositories.githubMoreRepos": "Load more repositories",
  "settings.repositories.githubBack": "Back to accounts",
  "settings.repositories.githubSaveOneRepo": "Authorize 1 repository",
  "settings.repositories.githubSaveRepos": "Authorize {count} repositories",
  "settings.repositories.githubEditWorkspaceAccess": "Change workspace access",
  "settings.repositories.githubShareHint":
    "Choose your personal GitHub account, or an organization where you administer repositories, to share with {organization}. Members with repository permissions in Studio can use this connection.",
  "settings.repositories.githubInstallHint":
    "Nothing here is yours to share yet. Install the GitHub App on your personal account or on repositories you administer, or ask an account owner to connect it to Studio. A repository you only collaborate on is not yours to share.",
  "settings.repositories.installGithubAccount": "Install on another account",
  "settings.repositories.checkGithubAccess": "Check access",
  "settings.repositories.switchGithubUser": "Use another GitHub login",
  "settings.repositories.githubReturnHint":
    "GitHub opens in a new tab. After saving access, return here to choose the account. If it does not appear, use Check access.",
  "settings.repositories.githubRefreshFailed":
    "Could not check GitHub access. Try again without leaving this dialog.",
  "settings.repositories.githubConnected": "GitHub account connected",
  "settings.repositories.manageRepositoryAccess": "Manage repository access",
  "settings.repositories.connectedBy": "Connected by {name}",
  "settings.repositories.connectedByUnknown":
    "Connected by an unavailable user",
  "settings.repositories.dismiss": "Dismiss",
  "settings.repositories.tryAgain": "Try again",
  "settings.repositories.oauthNoInstallations":
    "GitHub authorization succeeded, but no app installations are available to this user. Add a GitHub account or organization to finish setup.",
  "settings.repositories.oauthDenied":
    "Authorization was cancelled. Connect again when you are ready.",
  "settings.repositories.oauthExpired":
    "This connection attempt expired or belongs to another session. Start again from this page.",
  "settings.repositories.oauthNotConfigured":
    "This git provider is not configured. Ask an administrator to enable it.",
  "settings.repositories.oauthFailed":
    "Could not connect your git account. Try again. If it keeps failing, contact an administrator.",
  "settings.repositories.authKindGithubApp": "GitHub App",
  "settings.repositories.authKindOauth": "OAuth",
  "settings.repositories.authKindToken": "Personal token",
  "settings.repositories.accessUnavailable": "Access unavailable",
  "settings.repositories.accessUnavailableHint":
    "Studio cannot access this account. Authorize it again to continue using its repositories.",
  "settings.repositories.githubReconnect": "Reconnect GitHub",
  "settings.repositories.authorizeWorkspaceAccess":
    "Authorize workspace access",
  "settings.repositories.selectRepositories": "Select repositories",
  "settings.repositories.authorizationRequired":
    "Workspace authorization required",
  "settings.repositories.authorizationRequiredHint":
    "Studio has a GitHub App installation recorded for {login}, but this workspace has no authorization to use it. Sign in to GitHub and choose the repositories to share with this workspace.",
  "settings.repositories.accessRevoked": "Access revoked",
  "settings.repositories.accessRevokedHint":
    "Access to this account was revoked. Authorize it again to restore repository access.",
  "settings.repositories.noAuthorizedRepositories":
    "No repositories authorized",
  "settings.repositories.noAuthorizedRepositoriesHint":
    "This workspace has no repositories authorized through {login}. Select which repositories it can use.",
  "settings.repositories.providerUnavailable": "Provider unavailable",
  "settings.repositories.providerUnavailableHint":
    "This deployment is not configured to access this account. Ask an administrator to enable the provider.",
  "settings.repositories.installationMissing": "GitHub connection incomplete",
  "settings.repositories.installationMissingHint":
    "Studio has no GitHub App installation linked to this account. Connect GitHub and select the installation for {login}.",
  "settings.repositories.githubReconnectUnavailable":
    "GitHub reconnection is unavailable on this deployment. Ask an administrator to configure the GitHub App, then authorize workspace access.",
  "settings.repositories.disconnect": "Disconnect",
  "settings.repositories.disconnectTitle": 'Disconnect "{login}"?',
  "settings.repositories.disconnectDescription":
    "Repositories linked through this account stay listed, but become anonymous public clones — private ones will stop working.",
  "settings.repositories.disconnected": "Account disconnected",
  "settings.repositories.tokenDialogTitle": "Connect GitLab with a token",
  "settings.repositories.tokenDialogDescription":
    "Use a personal, project or group access token with the api scope — agents push branches and open merge requests with it. Stored encrypted and never shown again.",
  "settings.repositories.tokenDialogTitleBitbucket":
    "Connect Bitbucket with a token",
  "settings.repositories.tokenDialogDescriptionBitbucket":
    "Use a workspace, project or repository access token that can write repositories and pull requests — agents push branches and open pull requests with it. Bitbucket Cloud only. Stored encrypted and never shown again.",
  "settings.repositories.addAccount": "Add account",
  "settings.repositories.addAccountTitle": "Connect a git account",
  "settings.repositories.addAccountDescription":
    "Choose where your repositories live.",
  "settings.repositories.chooseMethodDescription":
    "Pick how Studio should connect to this provider.",
  "settings.repositories.back": "Back",
  "settings.repositories.providerGithub": "GitHub",
  "settings.repositories.providerGitlab": "GitLab",
  "settings.repositories.providerBitbucket": "Bitbucket",
  "settings.repositories.providerGithubHint":
    "Install the Studio app and pick the repositories to share.",
  "settings.repositories.providerTokenOrOauthHint":
    "Connect with an access token, or authorize with OAuth.",
  "settings.repositories.providerTokenOnlyHint":
    "Connect with an access token.",
  "settings.repositories.methodToken": "Use an access token",
  "settings.repositories.methodTokenHint":
    "The provider limits the token to the repositories you scope it to.",
  "settings.repositories.methodOauth": "Authorize with OAuth",
  "settings.repositories.methodOauthHint":
    "Sign in and authorize Studio in your browser.",
  "settings.repositories.methodOauthScopeNote":
    "Reaches every repository this account can see; it cannot be narrowed to a subset.",
  "settings.repositories.methodApp": "Install the GitHub app",
  "settings.repositories.methodAppHint":
    "Choose exactly which repositories Studio may use.",
  "settings.repositories.tokenStepsTitle": "Creating the token",
  "settings.repositories.openProvider": "Open provider",
  "settings.repositories.tokenWorkspaceLabel": "Workspace",
  "settings.repositories.tokenWorkspacePlaceholder": "your-workspace",
  "settings.repositories.tokenWorkspaceHint":
    "The slug in your Bitbucket URL. An access token cannot name its own workspace, so Studio verifies it against this one.",
  "settings.repositories.tokenProjectLabel": "Project path (optional)",
  "settings.repositories.tokenProjectPlaceholder": "group/project",
  "settings.repositories.tokenProjectHint":
    "Fill this in to jump straight to that project’s token page.",
  "settings.repositories.bitbucketStep1":
    "Open the repository you want Studio to reach, or the project that groups them.",
  "settings.repositories.bitbucketStep2":
    "Settings → Security → Access tokens → Create token.",
  "settings.repositories.bitbucketStep3":
    "Grant Repositories read and write, and Pull requests read and write.",
  "settings.repositories.bitbucketStep4":
    "Paste the token below. Bitbucket keeps it to what you scoped it to.",
  "settings.repositories.gitlabStep1":
    "Open the project or group you want Studio to reach.",
  "settings.repositories.gitlabStep2":
    "Settings → Access tokens → Add new token.",
  "settings.repositories.gitlabStep3": "Role: Developer or above. Scope: api.",
  "settings.repositories.gitlabStep4":
    "Paste the token below. A project token only reaches that project.",
  "settings.repositories.tokenHostLabel": "Host",
  "settings.repositories.tokenHostPlaceholder": "gitlab.com",
  "settings.repositories.tokenLabel": "Access token",
  "settings.repositories.tokenPlaceholder": "glpat-…",
  "settings.repositories.tokenPlaceholderBitbucket": "ATCTT…",
  "settings.repositories.connect": "Connect",
  "settings.repositories.connecting": "Connecting…",
  "settings.repositories.connected": 'Connected as "{login}"',
  "settings.repositories.reposTitle": "Repositories",
  "settings.repositories.reposDescription":
    "Repositories available to this organization's agents and workflows.",
  "settings.repositories.reposEmptyTitle": "No repositories yet",
  "settings.repositories.reposEmptyDescription":
    "Choose a repository from a connected GitHub, GitLab or Bitbucket account.",
  "settings.repositories.addRepository": "Add repository",
  "settings.repositories.unlink": "Unlink",
  "settings.repositories.unlinkTitle": 'Unlink "{path}"?',
  "settings.repositories.unlinkDescription":
    "The repository is removed from this organization. Nothing is deleted on the provider.",
  "settings.repositories.unlinked": "Repository unlinked",
  "settings.repositories.defaultBranch": "Default branch: {branch}",
  "settings.repositories.openInProvider": "Open repository",
  "settings.repositories.visibilityPublic": "Public",
  "settings.repositories.visibilityPrivate": "Private",
  "settings.repositories.visibilityInternal": "Internal",
  "settings.repositories.anonymousClone": "Anonymous clone",
  "settings.repositories.addDialogTitle": "Add repository",
  "settings.repositories.cancel": "Cancel",
  "settings.repositories.failed": "Something went wrong",
  "settings.nav.connections": "Connections",
  "settings.nav.agents": "Projects",
  "settings.nav.automations": "Automations",
  "settings.nav.skills": "Skills",
  "settings.nav.monitor": "Monitor",
  "settings.nav.members": "Members",
  "settings.nav.security": "Security",
  "settings.nav.profile": "Profile & Preferences",
  "settings.nav.backToHome": "Back to home",
  "settings.nav.signOut": "Sign Out",
  "settings.profile.avatar": "Avatar",
  "settings.profile.displayName": "Display name",
  "settings.profile.displayNamePlaceholder": "Your name",
  "settings.profile.email": "Email",
  "settings.profile.avatarUpload": "Change your picture",
  "settings.profile.avatarDialogTitle": "Profile picture",
  "settings.profile.avatarDialogDescription":
    "Drag to reposition and scroll to zoom. Only the picture you are using is visible to other people.",
  "settings.profile.avatarDeleted": "Picture deleted",
  "settings.profile.avatarRemove": "Remove",
  "settings.profile.avatarRemoved": "Picture removed",
  "settings.profile.avatarUpdated": "Picture updated",
  "settings.profile.avatarUploadError": "Failed to update the picture",
  "settings.profile.updateSuccess": "Profile updated successfully",
  "settings.profile.updateError": "Failed to update profile",
  "settings.preferences.title": "Preferences",
  "settings.preferences.compactPageLayout": "New Layout",
  "settings.preferences.compactPageLayoutDescription":
    "Try the redesigned navigation, page headers, and controls. Turn it off to return to the current layout.",
  "settings.preferences.theme": "Theme",
  "settings.preferences.themeDescription": "Your preferred color scheme.",
  "settings.preferences.themeLight": "Light theme",
  "settings.preferences.themeDark": "Dark theme",
  "settings.preferences.themeSystem": "System theme",
  "settings.preferences.language": "Language",
  "settings.preferences.languageDescription": "The language of the interface.",
  "settings.preferences.notifications": "Notifications",
  "settings.preferences.notificationsDescription":
    "Receive browser notifications for important events.",
  "settings.preferences.notificationsDenied":
    "Notifications denied. Please enable them in your browser settings.",
  "settings.preferences.sounds": "Sounds",
  "settings.preferences.soundsDescription":
    "Play sounds for agent actions and notifications.",
  "settings.preferences.soundsPreview": "Preview notification sound",
  "settings.preferences.toolApproval": "Tool Approval",
  "settings.preferences.toolApprovalDescription":
    "Control how tools are approved before execution.",
  "settings.preferences.toolApprovalAsk": "Ask before edit",
  "settings.preferences.toolApprovalAskShort": "Ask",
  "settings.preferences.toolApprovalAskDescription":
    "Auto-approve read-only tools",
  "settings.preferences.toolApprovalAuto": "Auto approve",
  "settings.preferences.toolApprovalAutoShort": "Auto",
  "settings.preferences.toolApprovalAutoDescription":
    "Execute all without approval",
  "settings.automations.browseAgentsButton": "Browse projects",
  "settings.automations.emptyDescription":
    "Automations are created per agent. Open an agent and add one from its Automations tab.",
  "settings.automations.emptyTitle": "No automations yet",
  "settings.automations.noResultsDescription":
    'No automations match "{search}"',
  "settings.automations.noResultsTitle": "No automations found",
  "settings.automations.pageTitle": "Automations",
  "settings.automations.searchPlaceholder": "Search automations...",
  "settings.skills.pageTitle": "Skills",
  "settings.skills.importButton": "Import skill",
  "settings.skills.importing": "Importing…",
  "settings.skills.importSuccess": 'Imported "{name}"',
  "settings.skills.importError": "Failed to import skill",
  "settings.skills.importMissingSkillMd":
    "That folder has no SKILL.md at its root. Pick the skill's own folder.",
  "settings.skills.importNeedsFolder":
    "Pick a folder, not individual files — this browser may not support folder upload.",
  "settings.skills.searchPlaceholder": "Search skills...",
  "settings.skills.noDescription": "No description",
  "settings.skills.filterAll": "All",
  "settings.skills.emptyTitle": "No skills yet",
  "settings.skills.emptyDescription":
    "Import a folder with a SKILL.md to give your agents reusable instructions they can load on demand.",
  "settings.skills.noResultsTitle": "No skills found",
  "settings.skills.noResultsDescription": 'No skills match "{search}"',
  "settings.skills.cancel": "Cancel",
  "settings.skills.deleteButton": "Delete",
  "settings.skills.deleteDialogTitle": "Delete this skill?",
  "settings.skills.deleteDialogDescription":
    'This removes "{name}" and its files. This can\'t be undone.',
  "settings.skills.deleteSuccess": "Skill deleted",
  "settings.skills.deleteError": "Failed to delete skill",
  "settings.skills.importTooManyFiles":
    "That folder has {count} files (limit {max}). Import a folder with just the skill's own files.",
  "settings.skills.importSlugTaken":
    'A skill named "{slug}" already exists. Delete it first to re-import.',
  "settings.skills.errorTitle": "Couldn't load skills",
  "settings.skills.errorDescription":
    "The skill catalog could not be loaded. You may not have access to this org's files.",
  "settings.skills.retry": "Try again",
  "settings.buckets.accessKeyIdLabel": "Access key ID",
  "settings.buckets.addBucket": "Add bucket",
  "settings.buckets.addBucketButton": "Add bucket",
  "settings.buckets.addS3Bucket": "Add S3 bucket",
  "settings.buckets.addingButton": "Adding…",
  "settings.buckets.apiKeyHelperText":
    "Sent as the x-api-key header on each refresh call.",
  "settings.buckets.apiKeyLabel": "API key",
  "settings.buckets.bucketAdded": 'Bucket "{name}" added',
  "settings.buckets.bucketLabel": "Bucket",
  "settings.buckets.bucketPlaceholder": "my-bucket",
  "settings.buckets.bucketRemoved": 'Bucket "{name}" removed',
  "settings.buckets.bucketsConfigured": "{count} bucket(s) configured",
  "settings.buckets.cancelButton": "Cancel",
  "settings.buckets.credentialsEncryptedDescription":
    "Credentials are encrypted at rest and never returned over the API. For Cloudflare R2, Google Cloud Storage, or MinIO, set a custom endpoint.",
  "settings.buckets.credentialsLabel": "Credentials",
  "settings.buckets.deleteButton": "Delete {name}",
  "settings.buckets.descriptionLabel": "Description (optional)",
  "settings.buckets.descriptionPlaceholder": "What is this bucket used for?",
  "settings.buckets.emptyStateDescription":
    "Add an S3-compatible bucket (AWS S3, Cloudflare R2, Google Cloud Storage, MinIO). Access keys are encrypted at rest and never returned over the API.",
  "settings.buckets.endpointHelperText":
    "Required for non-AWS providers (R2, GCS, MinIO).",
  "settings.buckets.endpointLabel": "Endpoint (optional)",
  "settings.buckets.endpointPlaceholder":
    "https://<account>.r2.cloudflarestorage.com",
  "settings.buckets.failedToAddBucket": "Failed to add bucket",
  "settings.buckets.failedToLoadConfigs":
    "Failed to load file configurations: {error}",
  "settings.buckets.failedToLoadConfigsFallback": "Failed to load file configs",
  "settings.buckets.failedToRemoveBucket": "Failed to remove bucket",
  "settings.buckets.forcePathStyleHelperText":
    "Required for Google Cloud Storage and most MinIO setups.",
  "settings.buckets.forcePathStyleLabel": "Force path-style URLs",
  "settings.buckets.managed": "Managed",
  "settings.buckets.nameHelperText":
    "Letters, digits, underscore, dot, hyphen. Unique within the organization.",
  "settings.buckets.nameLabel": "Name",
  "settings.buckets.namePlaceholder": "production-uploads",
  "settings.buckets.noBucketsConfigured": "No buckets configured",
  "settings.buckets.pathStyle": "path-style",
  "settings.buckets.prefix": "prefix: {prefix}",
  "settings.buckets.prefixHelperText":
    "All object keys are written under this prefix. Useful for multi-tenant buckets or credentials scoped to a sub-path. A trailing slash is added automatically.",
  "settings.buckets.prefixLabel": "Key prefix (optional)",
  "settings.buckets.prefixPlaceholder": "tenants/acme/",
  "settings.buckets.public": "public: {url}",
  "settings.buckets.publicUrlBaseHelperText":
    "Host used to build public URLs returned by the picker (R2 dev domain, CDN, custom host). Leave blank to use the bucket's S3 host (AWS default).",
  "settings.buckets.publicUrlBaseLabel": "Public URL base (optional)",
  "settings.buckets.publicUrlBasePlaceholder":
    "https://pub-xxxx.r2.dev or https://cdn.example.com",
  "settings.buckets.refreshUrlHelperText":
    "Endpoint POSTed (with the API key below) to vend temporary credentials. Must return accessKeyId, secretAccessKey, sessionToken, and expiration.",
  "settings.buckets.refreshUrlLabel": "Refresh URL",
  "settings.buckets.refreshUrlPlaceholder":
    "https://admin.example.com/api/acme/s3-credentials",
  "settings.buckets.regionLabel": "Region",
  "settings.buckets.regionPlaceholder": "us-east-1",
  "settings.buckets.removeBucketDescription":
    "This deletes the encrypted credentials for {name}. The bucket itself is not affected. This cannot be undone.",
  "settings.buckets.removeBucketTitle": "Remove bucket configuration?",
  "settings.buckets.removeButton": "Remove",
  "settings.buckets.removingButton": "Removing…",
  "settings.buckets.secretAccessKeyLabel": "Secret access key",
  "settings.buckets.staticKeyHelperText":
    "A long-lived access key ID and secret, used as-is.",
  "settings.buckets.staticKeyOption": "Static key pair (long-lived)",
  "settings.buckets.stsSessionHelperText":
    "Stores only a refresh endpoint + API key; short-lived credentials are fetched on demand and refreshed automatically.",
  "settings.buckets.temporarySessionOption":
    "Temporary session (STS, auto-refreshed)",
  "settings.connectClients.anyOtherClientDescription":
    "Any other MCP client: paste this endpoint into it to give that runtime every connection enabled in this org, governed by your Decopilot rules.",
  "settings.connectClients.apiKeyOption": "API key",
  "settings.connectClients.connectAClient": "Connect a client",
  "settings.connectClients.copy": "Copy",
  "settings.connectClients.doneHideKey": "Done, hide key",
  "settings.connectClients.generateKey": "Generate key",
  "settings.connectClients.generateKeyFor": "Generate key for {client}",
  "settings.connectClients.generatingKey": "Generating…",
  "settings.connectClients.headlessKeyHint":
    "For CI, Conductor, or headless agents that can't open a browser.",
  "settings.connectClients.installMethod": "Installation method",
  "settings.connectClients.keyCreated": "Key created",
  "settings.connectClients.oauthDiscoveryDetails": "OAuth discovery details",
  "settings.connectClients.oauthKeyHint":
    "Recommended for your laptop. Browser will open on first use to sign in — no token to manage.",
  "settings.connectClients.oauthMetadataHint":
    "OAuth 2.1 Protected Resource Metadata is advertised on 401:",
  "settings.connectClients.oauthOption": "OAuth",
  "settings.connectClients.otherClient": "Other",
  "settings.connectClients.pageTitle": "Connect to clients",
  "settings.connectClients.snippetOneTimeWarning":
    "Copy this snippet now — the key won't be shown again. You can revoke it later from the list below.",
  "settings.connectForms.apiKeyField": "API Key",
  "settings.connectForms.apiKeyRequired": "API key is required",
  "settings.connectForms.baseUrlField": "Base URL",
  "settings.connectForms.baseUrlPlaceholder": "http://localhost:4000/v1",
  "settings.connectForms.baseUrlRequired": "Base URL is required",
  "settings.connectForms.cancel": "Cancel",
  "settings.connectForms.connectionSavedSuccess":
    "Connection saved successfully",
  "settings.connectForms.defaultKeyLabel": "Personal key",
  "settings.connectForms.failedSaveConnection":
    "Failed to save connection: {error}",
  "settings.connectForms.failedSaveKey": "Failed to save key: {error}",
  "settings.connectForms.hideApiKey": "Hide API key",
  "settings.connectForms.keySavedSuccess": "Key saved successfully",
  "settings.connectForms.labelField": "Label",
  "settings.connectForms.labelPlaceholder": "e.g. Personal key",
  "settings.connectForms.labelPlaceholderOpenAiCompatible":
    "e.g. My OpenAI-compatible server",
  "settings.connectForms.labelPlaceholderPreset":
    "e.g. {name} prod, {name} dev",
  "settings.connectForms.optional": "optional",
  "settings.connectForms.recommended": "recommended",
  "settings.connectForms.saveConnection": "Save Connection",
  "settings.connectForms.saveKey": "Save Key",
  "settings.connectForms.saving": "Saving...",
  "settings.connectForms.showApiKey": "Show API key",
  "settings.connectProviderDialog.backButton": "Back",
  "settings.connectProviderDialog.backButtonLabel": "Back",
  "settings.connectProviderDialog.connectionTimedOutMessage":
    "Connection timed out",
  "settings.connectProviderDialog.defaultProviderName": "Provider",
  "settings.connectProviderDialog.defaultTitle": "Connect an AI provider",
  "settings.connectProviderDialog.gridDescription":
    "Pick a provider — we'll handle the rest.",
  "settings.connectProviderDialog.oauthFailedMessage":
    "OAuth connection failed: {error}",
  "settings.connectProviderDialog.oauthPendingMessage":
    "Authorize the connection in the popup window. This dialog will close once authorization completes.",
  "settings.connectProviderDialog.oauthSuccessMessage":
    "{provider} connected successfully",
  "settings.connectProviderDialog.provisionPendingMessage": "Connecting…",
  "settings.connectProviderDialog.provisionSuccessMessage":
    "{provider} connected successfully",
  "settings.connectProviderDialog.retryButton": "Retry",
  "settings.connectProviderDialog.securityCheckFailedMessage":
    "Security check failed: State token mismatch",
  "settings.connectProviderDialog.startOAuthFailedMessage":
    "Failed to start OAuth: {error}",
  "settings.connectedProvidersSection.connectButton": "Connect provider",
  "settings.connectedProvidersSection.emptyState":
    "Bring your own keys to use specific models alongside Deco's gateway.",
  "settings.connectedProvidersSection.sectionTitle": "Connected providers",
  "settings.claudeSubscription.active":
    "Your Claude plan is running these coding tasks.",
  "settings.claudeSubscription.connect": "Link",
  "settings.claudeSubscription.connected": "Claude subscription linked",
  "settings.claudeSubscription.description":
    "Run coding tasks on your own Claude Pro or Max plan instead of the organization's AI credit.",
  "settings.claudeSubscription.disconnect": "Disconnect",
  "settings.claudeSubscription.disconnected": "Claude subscription unlinked",
  "settings.claudeSubscription.expired":
    "Anthropic no longer accepts your token. Generate a new one to keep using your plan.",
  "settings.claudeSubscription.howTo":
    "Generate a token on your own machine with",
  "settings.claudeSubscription.title": "Your Claude subscription",
  "settings.claudeSubscription.tokenPlaceholder": "Paste your token",
  "settings.decoCreditsHero.add": "Add",
  "settings.decoCreditsHero.addCredits": "Add credits",
  "settings.decoCreditsHero.amountPlaceholder": "50",
  "settings.decoCreditsHero.availableBalance": "Available credit balance",
  "settings.decoCreditsHero.cancel": "Cancel",
  "settings.decoCreditsHero.cancelButton": "Cancel",
  "settings.decoCreditsHero.custom": "Custom",
  "settings.decoCreditsHero.decoAiGatewayAlt": "Deco AI Gateway",
  "settings.decoCreditsHero.disconnect": "Disconnect",
  "settings.decoCreditsHero.disconnectButton": "Disconnect",
  "settings.decoCreditsHero.disconnectDescription":
    "This will remove the Deco AI Gateway from this workspace. Your credit balance is preserved and will be available if you reconnect.",
  "settings.decoCreditsHero.disconnectError": "Failed to disconnect: {message}",
  "settings.decoCreditsHero.disconnectSuccess": "Deco AI Gateway disconnected",
  "settings.decoCreditsHero.disconnectTitle": "Disconnect Deco AI Gateway",
  "settings.decoCreditsHero.refreshBalance": "Refresh balance",
  "settings.decoCreditsHero.title": "Deco AI Gateway",
  "settings.planUsage.title": "Plan",
  "settings.planUsage.loadFailed": "Couldn't read this organization's plan.",
  "settings.planUsage.retry": "Retry",
  "settings.planUsage.aiUsage": "AI usage",
  "settings.planUsage.usageUnavailable": "Unavailable",
  "settings.planUsage.used": "used",
  "settings.plans.perMonth": "/ month",
  "settings.planUsage.periodHint":
    "Resets at the start of each billing period.",
  "settings.planUsage.oneTimeHint":
    "One-time trial credit. Top up to keep going, or upgrade for a monthly allowance.",
  "settings.planUsage.noAiIncluded": "No AI usage included.",
  "settings.planUsage.creditsLeft": "left",
  "settings.planUsage.manageBilling": "Manage billing",
  "settings.planUsage.portalFailed": "Couldn't open billing: {message}",
  "settings.planUsage.subscribe": "Subscribe",
  "settings.planUsage.changePlan": "Change plan",
  "settings.planUsage.downgrade": "Downgrade",
  "settings.planUsage.changed": "Plan updated",
  "settings.planUsage.changeFailed": "Couldn't change plan: {message}",
  "settings.planUsage.feature.cms": "CMS",
  "settings.planUsage.feature.chat": "Superagent chat",
  "settings.planUsage.feature.monitoring": "Site analytics",
  "settings.planUsage.feature.kanban": "Agentic Kanban",
  "settings.planUsage.feature.model_choice": "Choose your model",
  "settings.planUsage.feature.trialChat": "Limited access to chat",
  "settings.planUsage.feature.credits": "Extra credits",
  "settings.planUsage.feature.diagnostic": "Commerce diagnostic",
  "settings.planUsage.feature.diagnostic_enriched": "Enriched diagnostic",
  "settings.plans.title": "Plans",
  "settings.plans.loadFailed": "Couldn't load the plans.",
  "settings.plans.currentPlan": "Current plan",
  "settings.plans.downgradeTitle": "Downgrade to Free?",
  "settings.plans.downgradeDescription": "{plan} features stop right away.",
  "settings.plans.downgradeCancel": "Keep my plan",
  "settings.paywall.bullets.kanban.1":
    "Agents that do the work and move the cards",
  "settings.paywall.bullets.kanban.2": "A board the whole team shares",
  "settings.paywall.bullets.kanban.3": "Columns, tags and priorities",
  "settings.paywall.bullets.allowance.1": "A monthly allowance that resets",
  "settings.paywall.bullets.allowance.2": "Top up with extra credits any time",
  "settings.paywall.bullets.allowance.3": "Your message stays in the composer",
  "settings.paywall.bullets.cms.1": "Edit content and layout",
  "settings.paywall.bullets.cms.2": "Live preview as you go",
  "settings.paywall.bullets.cms.3": "Publish when it looks right",
  "settings.paywall.bullets.monitoring.1": "Pageviews, visitors and sources",
  "settings.paywall.bullets.monitoring.2": "Cache hit rate, latency and errors",
  "settings.paywall.bullets.monitoring.3": "Traffic by country and device",
  "settings.paywall.upgradeTitle": "{feature} comes with {plan}",
  "settings.paywall.upgradeDescription":
    "Unlocks it for everyone in the organization.",
  "settings.paywall.description":
    "This organization's plan doesn't include {feature}. Change the plan to unlock it for everyone in the org.",
  "settings.paywall.seePlans": "See plans",
  "settings.paywall.dismiss": "Not now",
  // Shown when the SERVER refuses, which is what happens in every window the
  // client's gate fails open — first paint, an org switch, a cross-pod skew
  // right after an upgrade. Without these the refusal arrived as a generic
  // error, indistinguishable from a bug.
  "settings.paywall.serverRefusedFeature":
    "Your plan does not include this. Ask an owner to upgrade, or see plans.",
  "settings.paywall.serverRefusedBudget":
    "This organization has used its monthly AI allowance. Chat and tasks pause until you upgrade or top up.",

  "settings.decoCreditsHero.topUpFailed": "Top-up failed: {message}",
  "settings.decoNudgeCard.connectDeco": "Connect Deco",
  "settings.decoNudgeCard.connecting": "Connecting…",
  "settings.decoNudgeCard.decoAiGateway": "Deco AI Gateway",
  "settings.decoNudgeCard.description":
    "100+ models, one connection — pay as you go, no API keys to juggle.",
  "settings.decoNudgeCard.recommended": "Recommended",
  "settings.deleteOrganizationSection.cancel": "Cancel",
  "settings.deleteOrganizationSection.dangerZone": "Danger Zone",
  "settings.deleteOrganizationSection.deleteButton": "Delete",
  "settings.deleteOrganizationSection.deleteOrganizationAction":
    "Delete organization",
  "settings.deleteOrganizationSection.deleteOrganizationDescription":
    "Permanently delete this organization and all of its data. This action cannot be undone.",
  "settings.deleteOrganizationSection.deleteOrganizationQuestion":
    "Delete Organization?",
  "settings.deleteOrganizationSection.deleteOrganizationTitle":
    "Delete organization",
  "settings.deleteOrganizationSection.deleteWarning":
    "This will permanently delete all data associated with {organizationName}. This action cannot be undone.",
  "settings.deleteOrganizationSection.deleting": "Deleting…",
  "settings.deleteOrganizationSection.failedToDeleteOrganization":
    "Failed to delete organization",
  "settings.deleteOrganizationSection.irreversibleActionsDescription":
    "Irreversible actions that affect your entire organization.",
  "settings.deleteOrganizationSection.organizationDeleted":
    "Organization deleted",
  "settings.deleteOrganizationSection.typeToConfirm":
    "Type {organizationName} to confirm:",
  "settings.domainSettings.addDnsRecordInstruction":
    "Add the DNS record below, then verify.",
  "settings.domainSettings.addDomain": "Add domain",
  "settings.domainSettings.adding": "Adding…",
  "settings.domainSettings.copied": "Copied",
  "settings.domainSettings.dnsInstructions":
    "Add this TXT record at your DNS provider, then click Verify:",
  "settings.domainSettings.domainAdded": "Domain added",
  "settings.domainSettings.domainPlaceholder": "acme.com",
  "settings.domainSettings.domainRemoved": "Domain removed",
  "settings.domainSettings.domainVerified": "Domain verified",
  "settings.domainSettings.emailDomains": "Email domains",
  "settings.domainSettings.emailDomainsDescription":
    "Let people with a matching email domain discover and join this organization.",
  "settings.domainSettings.failedAddDomain": "Failed to add domain",
  "settings.domainSettings.failedRemove": "Failed to remove",
  "settings.domainSettings.failedUpdate": "Failed to update",
  "settings.domainSettings.failedVerify": "Failed to verify",
  "settings.domainSettings.joinMode": "Join mode",
  "settings.domainSettings.joinModeAuto": "Auto-join",
  "settings.domainSettings.joinModeHelpAuto":
    "Anyone with a verified @{domain} email joins automatically.",
  "settings.domainSettings.joinModeHelpOff":
    "Not discoverable — no one can find or join through this domain.",
  "settings.domainSettings.joinModeHelpRequest":
    "People with a verified @{domain} email can request to join; an admin approves.",
  "settings.domainSettings.joinModeOff": "Off",
  "settings.domainSettings.joinModeRequest": "Require approval",
  "settings.domainSettings.joinModeUpdated": "Join mode updated",
  "settings.domainSettings.pending": "Pending",
  "settings.domainSettings.remove": "Remove",
  "settings.domainSettings.txt": "TXT",
  "settings.domainSettings.txtRecordNotFound":
    "TXT record not found yet — DNS can take a few minutes.",
  "settings.domainSettings.value": "value",
  "settings.domainSettings.verified": "Verified",
  "settings.domainSettings.verify": "Verify",
  "settings.editProviderDialog.apiKey": "API key",
  "settings.editProviderDialog.apiKeyRequiredForBaseUrlChange":
    "Enter the API key again to confirm changing the base URL",
  "settings.editProviderDialog.baseUrl": "Base URL",
  "settings.editProviderDialog.baseUrlPlaceholder": "http://localhost:4000/v1",
  "settings.editProviderDialog.cancel": "Cancel",
  "settings.editProviderDialog.editTitle": "Edit {name}",
  "settings.editProviderDialog.failedToUpdate": "Failed to update: {error}",
  "settings.editProviderDialog.hideApiKey": "Hide API key",
  "settings.editProviderDialog.label": "Label",
  "settings.editProviderDialog.labelPlaceholder": "e.g. Personal key",
  "settings.editProviderDialog.labelRequired": "Label is required",
  "settings.editProviderDialog.leaveBlankHint": "leave blank to keep current",
  "settings.editProviderDialog.providerUpdated": "Provider updated",
  "settings.editProviderDialog.save": "Save",
  "settings.editProviderDialog.saving": "Saving...",
  "settings.editProviderDialog.showApiKey": "Show API key",
  "settings.joinRequestsSection.approve": "Approve",
  "settings.joinRequestsSection.approveFailed": "Failed to approve",
  "settings.joinRequestsSection.approved": "Request approved",
  "settings.joinRequestsSection.deny": "Deny",
  "settings.joinRequestsSection.denied": "Request denied",
  "settings.joinRequestsSection.denyFailed": "Failed to deny",
  "settings.joinRequestsSection.description":
    "People who requested to join via a domain in approval mode.",
  "settings.joinRequestsSection.title": "Join requests",
  "settings.orgGeneral.organization": "Organization",
  "settings.review.title": "Reviewers & merge",
  "settings.review.description":
    "The automated Reviewer runs on a task's pull request once it's In Review (checks passing or none). It appears as a session on the task card.",
  "settings.review.reviewerTitle": "Enable Reviewer",
  "settings.review.reviewerDescription":
    "Reviews the code with the repository's own review skills, fixes what it finds on the pull request's branch, then exercises the change on the deploy preview — and hands the task to you when it can't settle something itself.",
  "settings.review.cheapReviewerModelTitle": "Run reviewers on a cheaper model",
  "settings.review.cheapReviewerModelDescription":
    "The Reviewer runs on a smaller model than the Super Agent that wrote the change. Cuts review cost; may cut review depth.",
  "settings.review.autoMergeTitle": "Enable Auto-merge",
  "settings.review.autoMergeDescription":
    "When every enabled reviewer approves, merge the pull request automatically instead of waiting for a human.",
  "settings.review.autoResolveConflictsTitle": "Auto-resolve merge conflicts",
  "settings.review.autoResolveConflictsDescription":
    "When an approved pull request conflicts with its base branch, hand it back to the Super Agent to check out the branch, merge the base and push. Follows Auto-merge unless you set it here.",
  "settings.review.deliveryLanesTitle": "Show delivery lanes",
  "settings.review.deliveryLanesDescription":
    "Add Approved, Merged and Post-deploy Validation between In Review and Done, and land a merged pull request on Merged instead of Done. For teams whose release process continues after the merge.",
  "settings.review.autoAssignReportTasksTitle":
    "Auto-assign report tasks to the Super Agent",
  "settings.review.autoAssignReportTasksDescription":
    "Tasks created from a report are delegated to the Super Agent automatically instead of landing unassigned.",
  "settings.review.updateError": "Couldn't update the setting",
  "settings.taskPrompt.title": "System prompt",
  "settings.taskPrompt.fieldLabel": "Instructions",
  "settings.taskPrompt.placeholder":
    "e.g. Use pnpm, never npm. Never edit files under src/generated/.",
  "settings.taskPrompt.save": "Save",
  "settings.taskPrompt.saved": "System prompt saved",
  "settings.taskPrompt.failed": "Couldn't save the system prompt",
  "settings.agentTools.title": "Agent tools",
  "settings.agentTools.description":
    "What a coding-agent run reaches beyond the repository it is working in.",
  "settings.agentTools.orgMcpsTitle": "Give runs this org's MCP connections",
  "settings.agentTools.orgMcpsDescription":
    "Every MCP you have connected becomes available to the Super Agent and the reviewers, on top of the task tools they always get. Tools load only when the agent looks for one, so connecting more does not crowd its context.",
  "settings.agentTools.orgMcpsPickTitle": "Connections runs can reach",
  "settings.agentTools.orgMcpsPickDescription":
    "Turn one off to keep it away from coding-agent runs. Useful for a connection that duplicates a tool a run already has \u2014 an MCP for the same tracker the run reports to, say. A newly connected MCP starts on.",
  "settings.agentTools.orgMcpsPickAriaLabel": "Let runs reach {name}",
  "settings.agentTools.orgMcpsPickEmpty":
    "This organization has no MCP connections yet",
  "settings.agentTools.orgMcpsPickFailed":
    "Could not save which connections runs can reach",
  "settings.agentTools.orgMcpsPickSearch": "Search connections\u2026",
  "settings.agentTools.orgMcpsPickEnableAll": "Enable all",
  "settings.agentTools.orgMcpsPickDisableAll": "Disable all",
  "settings.agentTools.orgMcpsPickNoMatch": "No connection matches that search",
  "settings.agentTools.orgMcpsPickSave": "Save",
  "settings.agentTools.orgMcpsPickSaving": "Saving\u2026",
  "settings.agentTools.orgMcpsPickDiscard": "Discard",
  "settings.agentTools.orgMcpsPickSaved":
    "Saved which connections runs can reach",
  "settings.agentTools.codingAgentsClaudeCodeTitle":
    "Run Code Agent chats with Claude Code",
  "settings.agentTools.codingAgentsClaudeCodeDescription":
    "Chats on an agent imported from a GitHub repo run inside that agent's sandbox, next to the checkout, instead of on Decopilot. Replies arrive a whole turn at a time rather than word by word. Only new chats are affected — an existing chat keeps the runtime it started on.",
  "settings.orgRoleDetail.addMember": "Add Member",
  "settings.orgRoleDetail.addMembersToGrantPermissions":
    "Add members to grant them the configured permissions.",
  "settings.orgRoleDetail.addMembersToRole": "Add Members to Role",
  "settings.orgRoleDetail.addWithCount": "Add ({count})",
  "settings.orgRoleDetail.added": "Added",
  "settings.orgRoleDetail.allModels": "All models",
  "settings.orgRoleDetail.allOrgPermissions": "All organization permissions",
  "settings.orgRoleDetail.allProjects": "All projects",
  "settings.orgRoleDetail.allProjectsDescription":
    "This role can access every project. Turn off to restrict it to specific projects.",
  "settings.orgRoleDetail.builtinRolePermissionsCannotBeChanged":
    "Built-in role permissions cannot be changed",
  "settings.orgRoleDetail.cancel": "Cancel",
  "settings.orgRoleDetail.createRole": "Create Role",
  "settings.orgRoleDetail.enabledCount": "{enabledCount}/{total} enabled",
  "settings.orgRoleDetail.failedToSaveRole": "Failed to save role",
  "settings.orgRoleDetail.general": "General",
  "settings.orgRoleDetail.grantFullAccessToAllFeaturesBelow":
    "Grant full access to all features below",
  "settings.orgRoleDetail.loadingModels": "Loading models...",
  "settings.orgRoleDetail.mcpPermissions": "MCP Permissions",
  "settings.orgRoleDetail.members": "Members",
  "settings.orgRoleDetail.membersUpdatedSuccessfully":
    "Members updated successfully!",
  "settings.orgRoleDetail.models": "Models",
  "settings.orgRoleDetail.noLlmConnectionsConfigured":
    "No LLM connections configured",
  "settings.orgRoleDetail.noMembers": "No members",
  "settings.orgRoleDetail.noMembersAvailable": "No members available",
  "settings.orgRoleDetail.noMembersFound": "No members found",
  "settings.orgRoleDetail.noMembersMatch": 'No members match "{searchQuery}"',
  "settings.orgRoleDetail.noPermissionsMatch":
    'No permissions match "{searchQuery}"',
  "settings.orgRoleDetail.noProjectsAvailable": "No projects available",
  "settings.orgRoleDetail.noProjectsMatch": 'No projects match "{searchQuery}"',
  "settings.orgRoleDetail.organizationPermissions": "Organization Permissions",
  "settings.orgRoleDetail.owner": "Owner",
  "settings.orgRoleDetail.ownerMembershipCannotBeChanged":
    "Owner membership cannot be changed",
  "settings.orgRoleDetail.projects": "Projects",
  "settings.orgRoleDetail.removeMember": "Remove {name} from role",
  "settings.orgRoleDetail.roleCreatedSuccessfully":
    "Role created successfully!",
  "settings.orgRoleDetail.roleName": "Role name",
  "settings.orgRoleDetail.roleNameIsRequired": "Role name is required",
  "settings.orgRoleDetail.roleUpdatedSuccessfully":
    "Role updated successfully!",
  "settings.orgRoleDetail.saveChanges": "Save Changes",
  "settings.orgRoleDetail.saving": "Saving...",
  "settings.orgRoleDetail.searchMcpServers": "Search MCP servers...",
  "settings.orgRoleDetail.searchMembers": "Search members...",
  "settings.orgRoleDetail.searchModels": "Search models...",
  "settings.orgRoleDetail.searchPermissions": "Search permissions...",
  "settings.orgRoleDetail.searchProjects": "Search projects...",
  "settings.orgRoleDetail.selectMembersToAddToThisRole":
    "Select members to add to this role.",
  "settings.orgRoleDetail.showMore": "Show more ({remaining} remaining)",
  "settings.orgRoleDetail.somethingWentWrong": "Something went wrong",
  "settings.orgRoleDetail.unknown": "Unknown",
  "settings.orgRoleDetail.userIsDefaultRoleMessage":
    "User is the default role — members can't be removed from it; assign another role to change their access",
  "settings.orgSso.cancelButton": "Cancel",
  "settings.orgSso.clientIdLabel": "Client ID",
  "settings.orgSso.clientIdPlaceholder": "your-client-id",
  "settings.orgSso.clientSecretEditDescription": "Leave empty to keep current",
  "settings.orgSso.clientSecretLabel": "Client Secret",
  "settings.orgSso.clientSecretPlaceholder": "your-client-secret",
  "settings.orgSso.clientSecretRequiredError":
    "Client Secret is required for initial setup",
  "settings.orgSso.configurationRemovedSuccess": "SSO configuration removed",
  "settings.orgSso.configurationSavedSuccess": "SSO configuration saved",
  "settings.orgSso.configureSsoButton": "Configure SSO",
  "settings.orgSso.discoveryEndpointDescription":
    "Optional — auto-detected from issuer if omitted.",
  "settings.orgSso.discoveryEndpointLabel": "Discovery Endpoint",
  "settings.orgSso.discoveryEndpointPlaceholder": "Auto-detected from issuer",
  "settings.orgSso.domainLabel": "Domain",
  "settings.orgSso.editConfigButton": "Edit configuration",
  "settings.orgSso.emailDomainDescription":
    "The email domain this SSO provider covers.",
  "settings.orgSso.emailDomainLabel": "Email Domain",
  "settings.orgSso.emailDomainPlaceholder": "company.com",
  "settings.orgSso.enforceSsoDescription":
    "Require all members to authenticate via SSO",
  "settings.orgSso.enforceSsoLabel": "Enforce SSO",
  "settings.orgSso.enforcementDisabledSuccess": "SSO enforcement disabled",
  "settings.orgSso.enforcementEnabledSuccess": "SSO enforcement enabled",
  "settings.orgSso.issuerUrlDescription":
    "The OIDC issuer URL of your identity provider.",
  "settings.orgSso.issuerUrlLabel": "Issuer URL",
  "settings.orgSso.issuerUrlPlaceholder":
    "https://login.microsoftonline.com/{tenant}/v2.0",
  "settings.orgSso.loading": "Loading...",
  "settings.orgSso.providerLabel": "Provider",
  "settings.orgSso.removeButton": "Remove",
  "settings.orgSso.removeConfirmation":
    "Are you sure you want to remove SSO configuration?",
  "settings.orgSso.removeSsoConfigError": "Failed to remove SSO config",
  "settings.orgSso.requiredFieldsError":
    "Issuer, Client ID, and Domain are required",
  "settings.orgSso.saveSsoConfigError": "Failed to save SSO config",
  "settings.orgSso.savingButton": "Saving...",
  "settings.orgSso.scopesLabel": "Scopes",
  "settings.orgSso.scopesPlaceholder": "openid email profile",
  "settings.orgSso.sectionTitle": "Single Sign-On",
  "settings.orgSso.securityTitle": "Security",
  "settings.orgSso.testSsoButton": "Test SSO",
  "settings.orgSso.toggleEnforcementError": "Failed to toggle SSO enforcement",
  "settings.orgSso.updateButton": "Update",
  "settings.organizationForm.failedToReadImage": "Failed to read image",
  "settings.organizationForm.failedToUpdateOrg":
    "Failed to update organization",
  "settings.organizationForm.imageTooLarge": "Image must be smaller than 2MB",
  "settings.organizationForm.logoDescription": "Recommended size is 256x256px",
  "settings.organizationForm.logoTitle": "Logo",
  "settings.organizationForm.namePlaceholder": "Organization name",
  "settings.organizationForm.nameRequired": "Name is required",
  "settings.organizationForm.nameTitle": "Name",
  "settings.organizationForm.nameTooLong": "Name is too long",
  "settings.organizationForm.updateSuccess":
    "Organization updated successfully",
  "settings.organizationForm.uploadLogoLabel": "Upload organization logo",
  "settings.organizationForm.urlDescription":
    "Can't be changed — it's used in URLs and API integrations.",
  "settings.organizationForm.urlTitle": "URL",
  "settings.providerKeyRow.addedTimeAgo": "{label} · added {time} ago",
  "settings.providerKeyRow.cancel": "Cancel",
  "settings.providerKeyRow.claudeCode": "Claude Code",
  "settings.providerKeyRow.codex": "Codex",
  "settings.providerKeyRow.delete": "Delete",
  "settings.providerKeyRow.deleteApiKey": "Delete API key",
  "settings.providerKeyRow.deleteProviderKey": "Delete provider key",
  "settings.providerKeyRow.editProviderKey": "Edit provider key",
  "settings.providerKeyRow.failedToDeleteKey": "Failed to delete key: {error}",
  "settings.providerKeyRow.keyDeleted": "Key deleted",
  "settings.roles.allConnections": "All connections",
  "settings.roles.basicAccess": "Basic access",
  "settings.roles.builtIn": "Built-in",
  "settings.roles.cancel": "Cancel",
  "settings.roles.columnMembers": "Members",
  "settings.roles.columnPermissions": "Permissions",
  "settings.roles.columnRole": "Role",
  "settings.roles.columnType": "Type",
  "settings.roles.connectionCount": "{count} connection(s)",
  "settings.roles.createRole": "Create Role",
  "settings.roles.createRoleGetStarted": "Create a role to get started.",
  "settings.roles.custom": "Custom",
  "settings.roles.delete": "Delete",
  "settings.roles.deleteRoleConfirm":
    'Are you sure you want to delete the "{role}" role? This action cannot be undone.',
  "settings.roles.deleteRoleTitle": "Delete Role",
  "settings.roles.deletedSuccessfully": "Role deleted successfully!",
  "settings.roles.failedToLoad": "Failed to load roles",
  "settings.roles.fullAccess": "Full access",
  "settings.roles.fullOrgAccess": "Full org access",
  "settings.roles.noPermissions": "No permissions",
  "settings.roles.noRoles": "No roles",
  "settings.roles.noRolesFound": "No roles found",
  "settings.roles.noRolesMatchSearch": 'No roles match "{search}"',
  "settings.roles.orgPermsCount": "{count} org perm(s)",
  "settings.roles.pageTitle": "Roles",
  "settings.roles.roleAdmin": "Admin",
  "settings.roles.roleOwner": "Owner",
  "settings.roles.roleUser": "User",
  "settings.roles.searchPlaceholder": "Search roles...",
  "settings.apiKeys.cancelButton": "Cancel",
  "settings.apiKeys.copied": "Copied to clipboard",
  "settings.apiKeys.copyKey": "Copy key",
  "settings.apiKeys.createButton": "Create key",
  "settings.apiKeys.createdAt": "Created {date}",
  "settings.apiKeys.createdDescription":
    "Copy this key now — it won't be shown again.",
  "settings.apiKeys.createdTitle": "API key created",
  "settings.apiKeys.creatingButton": "Creating…",
  "settings.apiKeys.deleteDescription":
    "Any application using this key will immediately lose access. This cannot be undone.",
  "settings.apiKeys.deleteKey": "Delete key",
  "settings.apiKeys.deleteTitle": 'Delete "{name}"?',
  "settings.apiKeys.done": "Done",
  "settings.apiKeys.emptyDescription":
    "Create a key to authenticate external applications with this organization.",
  "settings.apiKeys.emptyTitle": "No API keys yet",
  "settings.apiKeys.failedToCreateKey": "Failed to create API key",
  "settings.apiKeys.failedToDeleteKey": "Failed to delete API key",
  "settings.apiKeys.failedToLoadError": "Failed to load API keys: {error}",
  "settings.apiKeys.keyDeleted": 'API key "{name}" deleted',
  "settings.apiKeys.loading": "Loading API keys…",
  "settings.apiKeys.nameLabel": "Name",
  "settings.apiKeys.namePlaceholder": "My integration",
  "settings.apiKeys.newKey": "New key",
  "settings.apiKeys.newKeyDescription":
    "Give the key a name so you can recognize it later.",
  "settings.apiKeys.newKeyTitle": "New API key",
  "settings.apiKeys.sectionDescription":
    "Long-lived keys for scripts and clients that can't sign in through a browser.",
  "settings.apiKeys.sectionTitle": "API keys",
  "settings.secrets.cancelButton": "Cancel",
  "settings.secrets.createButton": "Create secret",
  "settings.secrets.creatingButton": "Creating…",
  "settings.secrets.descriptionLabel": "Description (optional)",
  "settings.secrets.descriptionPlaceholder": "What is this secret used for?",
  "settings.secrets.emptyDescription":
    "Store API keys, tokens, and other sensitive values. Values are encrypted at rest and never returned over the API.",
  "settings.secrets.emptyTitle": "No secrets yet",
  "settings.secrets.failedToCreateSecret": "Failed to create secret",
  "settings.secrets.failedToLoadError": "Failed to load secrets: {error}",
  "settings.secrets.nameHelp":
    "Letters, digits, underscore, dot, hyphen. Case-insensitive within its scope.",
  "settings.secrets.nameLabel": "Name",
  "settings.secrets.namePlaceholder": "STRIPE_API_KEY",
  "settings.secrets.newSecret": "New secret",
  "settings.secrets.newSecretDescription":
    "Stored encrypted in the credential vault. Choose who can read it.",
  "settings.secrets.newSecretTitle": "New secret",
  "settings.secrets.scopeLabel": "Scope",
  "settings.secrets.scopeOrganization": "Organization",
  "settings.secrets.scopeOrganizationDescription":
    "Organization — visible to all members",
  "settings.secrets.scopePrivate": "Private",
  "settings.secrets.scopePrivateDescription": "Private — only visible to me",
  "settings.secrets.secretCreated": 'Secret "{name}" created',
  "settings.secrets.secretsCountSingular": "{count} secret stored",
  "settings.secrets.secretsCountPlural": "{count} secrets stored",
  "settings.secrets.sectionOrganization": "Organization",
  "settings.secrets.sectionPrivate": "Private to me",
  "settings.secrets.valueLabel": "Value",
  "settings.simpleModeSection.defaultModels": "Default models",
  "settings.simpleModeSection.failedToSave": "Failed to save: {error}",
  "settings.simpleModeSection.modelsPowerDescription":
    "These models power chat, automations, and tools across your organization.",
  "settings.simpleModeSection.notAvailableWithCurrentProvider":
    "Not available with current provider",
  "settings.simpleModeSection.pickModel": "Pick model",
  "settings.simpleModeSection.saved": "Saved",
  "settings.simpleModeSection.saving": "Saving…",
  "settings.simpleModeSection.tierDeepResearch": "Deep research",
  "settings.simpleModeSection.tierDeepResearchDesc":
    "In-depth, multi-source research reports",
  "settings.simpleModeSection.tierFast": "Fast",
  "settings.simpleModeSection.tierFastDesc":
    "Fastest responses, best for quick tasks",
  "settings.simpleModeSection.tierImage": "Image",
  "settings.simpleModeSection.tierImageDesc": "Image generation",
  "settings.simpleModeSection.tierSmart": "Smart",
  "settings.simpleModeSection.tierSmartDesc": "Balanced speed and capability",
  "settings.simpleModeSection.tierThinking": "Thinking",
  "settings.simpleModeSection.tierThinkingDesc":
    "Most capable, best for complex tasks",
  "settings.simpleModeSection.tierWebSearch": "Web search",
  "settings.simpleModeSection.tierWebSearchDesc":
    "Quick, up-to-date answers from the web",
  "settings.aiProviders.recommended":
    "Recommended — 100+ models, pay as you go",
  "settings.aiProviders.customOpenAiCompatible": "Custom OpenAI-compatible",
  "settings.aiProviders.customOpenAiDescription":
    "Bring your own model server (advanced)",
  "settings.aiProviders.moreProvidersSingular": "{count} more provider",
  "settings.aiProviders.moreProvidersPlural": "{count} more providers",
  "settings.aiProviders.decoConnectSuccess":
    "Deco AI Gateway connected successfully",
  "settings.aiProviders.decoConnectError":
    "Failed to connect Deco AI Gateway: {error}",

  "settings.infraBilling.noSites":
    "This organization doesn't own any deco.cx site yet.",
  "settings.infraBilling.siteLabel": "Sites",
  "settings.infraBilling.pickASite": "Select at least one site.",
  "settings.infraBilling.tooManySites":
    "Showing the first {count} sites. Select specific sites to see the rest.",
  "settings.infraBilling.multipleTeams":
    "Plan and invoices belong to a single legacy team — narrow the selection to see them.",
  "settings.infraBilling.noTeam":
    "These sites aren't linked to a legacy billing team.",
  "settings.infraBilling.partialTeam":
    "This site's legacy team also bills sites outside this organization, so its plan and invoices aren't shown here.",
  "settings.infraBilling.billingUnavailable":
    "Plan and invoices are temporarily unavailable.",
  "settings.infraBilling.monthLabel": "Month",
  "settings.infraBilling.warehouseUnavailable":
    "Usage data couldn't be read, so the figures below are incomplete.",
  "settings.infraBilling.summaryTitle": "Summary",
  "settings.infraBilling.metricsTitle": "Metrics",
  "settings.infraBilling.invoicesTitle": "Invoices",
  "settings.infraBilling.detailsTitle": "Billing details",
  "settings.infraBilling.currentPlan": "Current plan",
  "settings.infraBilling.nextBilling": "Next billing",
  "settings.infraBilling.manageButton": "Manage",
  "settings.infraBilling.portalError":
    "Couldn't open billing portal: {message}",
  "settings.infraBilling.requestsPerPageview": "Requests per pageview",
  "settings.infraBilling.plan.free": "Free",
  "settings.infraBilling.plan.pro": "Pro",
  "settings.infraBilling.plan.enterprise": "Enterprise",
  "settings.infraBilling.pageviews": "Pageviews",
  "settings.infraBilling.pageviewsDescription":
    "Pages served to visitors this month.",
  "settings.infraBilling.requests": "Requests",
  "settings.infraBilling.requestsDescription":
    "CDN and shared infrastructure requests.",
  "settings.infraBilling.dataTransfer": "Data transfer",
  "settings.infraBilling.dataTransferDescription":
    "Bandwidth served from the edge and the origin.",
  "settings.infraBilling.noInvoices": "No invoices issued for this site.",
  "settings.infraBilling.invoiceReference": "Reference",
  "settings.infraBilling.invoiceDue": "Due date",
  "settings.infraBilling.invoiceAmount": "Amount",
  "settings.infraBilling.invoiceStatus": "Status",
  "settings.infraBilling.invoiceDocuments": "Documents",
  "settings.infraBilling.invoiceNf": "Invoice",
  "settings.infraBilling.invoiceBankSlip": "Bank slip",
  "settings.infraBilling.invoiceBankTransfer": "Bank transfer",
  "settings.infraBilling.statusPaid": "Paid",
  "settings.infraBilling.statusOverdue": "Overdue",
  "settings.infraBilling.statusPending": "Pending",
  "settings.gitCredentials.title": "Git credentials",
  "settings.gitCredentials.description":
    "Personal access tokens for private git repositories your projects pull from but a sandbox cannot otherwise reach — submodules, and private dependencies resolved by pub, go, npm or cargo. Used by every sandbox in this organization. Reference an org/user secret per host; SSH URLs are rewritten to HTTPS so the token applies.",
  "settings.gitCredentials.addCredential": "Add git credential",
  "settings.gitCredentials.cancel": "Cancel",
  "settings.gitCredentials.createNewSecret": "Create new secret",
  "settings.gitCredentials.createNewSecretAriaLabel": "Create new secret",
  "settings.gitCredentials.createNewSecretDescription":
    "Stored encrypted in the credential vault. The git credential will reference the new secret by id — its value never leaves the server.",
  "settings.gitCredentials.createNewSecretTitle": "Create new secret",
  "settings.gitCredentials.descriptionLabel": "Description (optional)",
  "settings.gitCredentials.descriptionPlaceholder":
    "What is this token used for?",
  "settings.gitCredentials.failedToLoadSecrets": "Failed to load secrets",
  "settings.gitCredentials.failedToSave": "Failed to save git credentials",
  "settings.gitCredentials.failedToSaveSecret": "Failed to save",
  "settings.gitCredentials.hostAriaLabel": "Git credential {index} host",
  "settings.gitCredentials.hostInvalidMessage":
    "Bare hostname, e.g. github.com (no scheme or path).",
  "settings.gitCredentials.hostPlaceholder": "github.com",
  "settings.gitCredentials.nameLabel": "Name",
  "settings.gitCredentials.namePlaceholder": "GITHUB_DEPS_PAT",
  "settings.gitCredentials.nameHelperText":
    "Letters, digits, underscore, dot, hyphen.",
  "settings.gitCredentials.noSecretsYet":
    'No secrets yet. Use the "+" to create one.',
  "settings.gitCredentials.pickSecretPlaceholder": "Pick a secret…",
  "settings.gitCredentials.remove": "Remove",
  "settings.gitCredentials.removeAriaLabel": "Remove git credential",
  "settings.gitCredentials.saveSecret": "Save secret",
  "settings.gitCredentials.saving": "Saving…",
  "settings.gitCredentials.secretAriaLabel": "Git credential {index} secret",
  "settings.gitCredentials.scopeLabel": "Scope",
  "settings.gitCredentials.scopeOrganization":
    "Organization — visible to all members",
  "settings.gitCredentials.scopePrivate": "Private — only visible to me",
  "settings.gitCredentials.secretSaved": 'Saved secret "{name}"',
  "settings.gitCredentials.tokenExposureWarning":
    "The token is installed in the sandbox's git config for the session, so commands and agents running there can use it. Scope it to the repositories it needs.",
  "settings.gitCredentials.tokenLabel": "Personal access token",
  "settings.gitCredentials.tokenPlaceholder": "ghp_…",
} as const;
