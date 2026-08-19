export const settings = {
  "settings.title": "Profile & Preferences",
  "settings.nav.organization": "Organization",
  "settings.nav.build": "Build",
  "settings.nav.manage": "Manage",
  "settings.nav.general": "General",
  "settings.nav.connect": "Connect",
  "settings.nav.aiProviders": "AI Providers",
  "settings.nav.secrets": "Secrets",
  "settings.nav.apiKeys": "API Keys",
  "settings.nav.billing": "Billing & AI",
  "settings.nav.buckets": "Buckets",
  "settings.nav.syncedRepos": "Synced repos",
  "settings.nav.storage": "Storage",
  "settings.nav.advanced": "Advanced",
  "settings.subnav.ariaLabel": "Settings sections",
  "settings.subnav.clients": "Clients",
  "settings.subnav.planUsage": "Plan & usage",
  "settings.subnav.infrastructure": "Infrastructure",
  "settings.nav.tasks": "Tasks",
  "settings.jira.sectionTitle": "Jira integration",
  "settings.jira.pageDescription":
    "Mirror a Jira project onto the task board. Issues in mapped statuses appear as cards and stay in sync every few minutes, and comments flow both ways — card comments show up on the issue and vice versa. Issue fields are never written back.",
  "settings.jira.connectTitle": "Connect Jira",
  "settings.jira.connectDescription":
    "Use a Jira Cloud site and an API token (ideally from a service account). Create one at id.atlassian.com → Security → API tokens.",
  "settings.jira.sitePlaceholder": "yourcompany.atlassian.net",
  "settings.jira.emailPlaceholder": "Atlassian account email",
  "settings.jira.tokenPlaceholder": "API token",
  "settings.jira.connect": "Connect",
  "settings.jira.connecting": "Connecting…",
  "settings.jira.connected": "Jira connected",
  "settings.jira.connectFailed": "Could not connect to Jira",
  "settings.jira.connectionTitle": "Connection",
  "settings.jira.disconnect": "Disconnect",
  "settings.jira.disconnected": "Jira disconnected",
  "settings.jira.disconnectTitle": "Disconnect Jira?",
  "settings.jira.disconnectDescription":
    "The sync stops and the credentials are deleted. Cards already on the board are kept — they just stop updating.",
  "settings.jira.cancel": "Cancel",
  "settings.jira.syncTitle": "Sync",
  "settings.jira.syncDescription":
    "Pick the Jira board to mirror and map its columns onto this board's lanes.",
  "settings.jira.boardLabel": "Jira board",
  "settings.jira.boardDescription":
    "The board's visible cards are mirrored — its Backlog tab, epics and sub-tasks are not.",
  "settings.jira.boardPlaceholder": "Select a board",
  "settings.jira.boardSearchPlaceholder": "Search boards…",
  "settings.jira.noBoardsMatch": "No board matches that search",
  "settings.jira.loadingBoards": "Loading boards…",
  "settings.jira.mappingLabel": "Column mapping",
  "settings.jira.mappingDescription":
    "Map the board's columns onto this board's lanes. Columns marked “Don't sync” never appear here.",
  "settings.jira.dontSync": "Don't sync",
  "settings.jira.jqlLabel": "JQL filter (optional)",
  "settings.jira.jqlDescription":
    "Extra JQL to narrow what syncs — useful to match your Jira board's saved filter. Epics and sub-tasks are always excluded.",
  "settings.jira.jqlPlaceholder":
    "e.g. labels = storefront AND sprint in openSprints()",
  "settings.jira.jqlSave": "Save filter",
  "settings.jira.jqlSaved": "Filter saved — it applies from the next sync",
  "settings.jira.columnsFailed": "Could not load the board's columns",
  "settings.jira.autoDelegateLabel": "Auto-delegate to the agent",
  "settings.jira.autoDelegateDescription":
    "When an issue lands in a column mapped to To Do, the Super Agent takes the card and starts working. Its progress is mirrored back onto the issue.",
  "settings.jira.enableLabel": "Sync enabled",
  "settings.jira.enableRequirements":
    "Pick a project and map at least one status before enabling the sync",
  "settings.jira.lastSynced": "Last synced {ago}",
  "settings.jira.waitingFirstSync": "Waiting for the first sync",
  "settings.jira.syncNow": "Sync now",
  "settings.jira.syncing": "Syncing…",
  "settings.jira.syncDone": "Synced: {created} created, {updated} updated",
  "settings.jira.syncFailed": "Sync failed",
  "settings.jira.saveFailed": "Could not save the Jira settings",
  "settings.jira.connectStep1":
    "Create an API token on your Atlassian account (ideally a service account that can see the project).",
  "settings.jira.connectStep2":
    "Fill in your Jira site, the account's email, and the token, then connect.",
  "settings.jira.connectStep3":
    "Pick the Jira board to mirror and map its columns onto this board's lanes.",
  "settings.jira.createTokenLink": "Create an API token",
  "settings.jira.webhookTitle": "Instant updates (webhook)",
  "settings.jira.webhookDescription":
    "Optional. Without it, changes made in Jira reach the board on the next 10-minute sync; with it, they arrive in seconds.",
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
    "Save. Changes made in Jira now show up on the board within seconds.",
  "settings.syncedRepos.pageDescription":
    "GitHub repositories mirrored into read-only library folders and kept in sync every few minutes. Great for a shared skills repo.",
  "settings.syncedRepos.addRepo": "Add repo",
  "settings.syncedRepos.cancel": "Cancel",
  "settings.syncedRepos.create": "Create",
  "settings.syncedRepos.creating": "Creating…",
  "settings.syncedRepos.created":
    'Sync created — syncing into "{volume}" in the background',
  "settings.syncedRepos.emptyTitle": "No synced repos yet",
  "settings.syncedRepos.emptyDescription":
    "Pick a GitHub repository and it will appear in the library as a read-only folder, kept in sync automatically.",
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
  "settings.nav.connections": "Connections",
  "settings.nav.agents": "Agents",
  "settings.nav.automations": "Automations",
  "settings.nav.store": "Store",
  "settings.nav.monitor": "Monitor",
  "settings.nav.members": "Members",
  "settings.nav.security": "Security",
  "settings.nav.profile": "Profile & Preferences",
  "settings.nav.signOut": "Sign Out",
  "settings.profile.avatar": "Avatar",
  "settings.profile.displayName": "Display name",
  "settings.profile.displayNamePlaceholder": "Your name",
  "settings.profile.email": "Email",
  "settings.profile.updateSuccess": "Profile updated successfully",
  "settings.profile.updateError": "Failed to update profile",
  "settings.preferences.title": "Preferences",
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
  "settings.automations.browseAgentsButton": "Browse agents",
  "settings.automations.emptyDescription":
    "Automations are created per agent. Open an agent and add one from its Automations tab.",
  "settings.automations.emptyTitle": "No automations yet",
  "settings.automations.noResultsDescription":
    'No automations match "{search}"',
  "settings.automations.noResultsTitle": "No automations found",
  "settings.automations.pageTitle": "Automations",
  "settings.automations.searchPlaceholder": "Search automations...",
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
  "settings.connectClients.activeKeys": "Active keys",
  "settings.connectClients.activeKeysDescription":
    "Keys you've generated for headless clients. Revoke any time.",
  "settings.connectClients.apiKeyTab": "API key",
  "settings.connectClients.copy": "Copy",
  "settings.connectClients.createdAt": "Created {date}",
  "settings.connectClients.customClientHint": "Wiring a custom client?",
  "settings.connectClients.doneHideKey": "Done, hide key",
  "settings.connectClients.failedToLoadKeys": "Failed to load keys: {error}",
  "settings.connectClients.generateKeyFor": "Generate key for {client}",
  "settings.connectClients.generatingKey": "Generating…",
  "settings.connectClients.headlessKeyHint":
    "For CI, Conductor, or headless agents that can't open a browser.",
  "settings.connectClients.keyCreated": "Key created",
  "settings.connectClients.keyRevoked": "Key revoked",
  "settings.connectClients.loadingActiveKeys": "Loading active keys…",
  "settings.connectClients.noConnectKeysYet":
    "No connect keys minted yet. Generate one from a client tab above for headless setups.",
  "settings.connectClients.oauthKeyHint":
    "Recommended for your laptop. Browser will open on first use to sign in — no token to manage.",
  "settings.connectClients.oauthMetadataHint":
    "OAuth 2.1 Protected Resource Metadata is advertised on 401:",
  "settings.connectClients.oauthTab": "OAuth",
  "settings.connectClients.orgUnifiedMcp": "Your org's unified MCP",
  "settings.connectClients.orgUnifiedMcpDescription":
    "Plug this URL into any MCP client to give that runtime every connection enabled in this org, governed by your Decopilot rules.",
  "settings.connectClients.pageTitle": "Connect to clients",
  "settings.connectClients.revoke": "Revoke",
  "settings.connectClients.revokeConfirm":
    'Revoke "{name}"? Any client still using this key will lose access.',
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
  "settings.decoCreditsHero.accessModels": "Access to 100+ models",
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
  "settings.joinRequestsSection.deny": "Deny",
  "settings.joinRequestsSection.description":
    "People who requested to join via a domain in approval mode.",
  "settings.joinRequestsSection.title": "Join requests",
  "settings.navigation.title": "Navigation",
  "settings.navigation.description":
    "How this organization gets around Studio.",
  "settings.navigation.updateError": "Couldn't update navigation settings",
  "settings.navigation.navV2Title": "First-class navigation",
  "settings.navigation.navV2Description":
    "The sidebar lists destinations (Reports, Library, Tasks) instead of chats, and the chat list moves to the top of the chat panel. On by default for report organizations.",
  "settings.orgGeneral.organization": "Organization",
  "settings.mainAgent.title": "Main agent",
  "settings.mainAgent.description":
    "The agent this organization opens on. Every member lands here instead of the Super Agent.",
  "settings.mainAgent.itemTitle": "Landing agent",
  "settings.mainAgent.itemDescription":
    "Pick the agent to open when entering this organization.",
  "settings.mainAgent.superAgentOption": "Super Agent (default)",
  "settings.mainAgent.setToast": '"{title}" is now the main agent',
  "settings.mainAgent.resetToast": "Reset to the Super Agent",
  "settings.mainAgent.errorToast": "Couldn't update the main agent",
  "settings.review.title": "Reviewers & merge",
  "settings.review.description":
    "Automated reviewers run on a task's pull request once it's In Review (checks passing or none). Both appear as sessions on the task card.",
  "settings.review.qaAgentTitle": "Enable QA Agent",
  "settings.review.qaAgentDescription":
    "Verifies the task actually solved the problem — exercises the feature, not just the diff.",
  "settings.review.codeReviewerTitle": "Enable Code Reviewer",
  "settings.review.codeReviewerDescription":
    "Reviews the code using the repository's stack-appropriate review skills.",
  "settings.review.cheapReviewerModelTitle": "Run reviewers on a cheaper model",
  "settings.review.cheapReviewerModelDescription":
    "The QA Agent and Code Reviewer read a diff and reach a verdict, so they run on a smaller model than the Super Agent that wrote the change. Cuts review cost; may cut review depth.",
  "settings.review.autoMergeTitle": "Enable Auto-merge",
  "settings.review.autoMergeDescription":
    "When every enabled reviewer approves, merge the pull request automatically instead of waiting for a human. If a conflict blocks the merge, the Super Agent resolves it first.",
  "settings.review.autoAssignReportTasksTitle":
    "Auto-assign report tasks to the Super Agent",
  "settings.review.autoAssignReportTasksDescription":
    "Tasks created from a report are delegated to the Super Agent automatically instead of landing unassigned.",
  "settings.review.updateError": "Couldn't update the setting",
  "settings.orgRoleDetail.addMember": "Add Member",
  "settings.orgRoleDetail.addMembersToGrantPermissions":
    "Add members to grant them the configured permissions.",
  "settings.orgRoleDetail.addMembersToRole": "Add Members to Role",
  "settings.orgRoleDetail.addWithCount": "Add ({count})",
  "settings.orgRoleDetail.added": "Added",
  "settings.orgRoleDetail.allModels": "All models",
  "settings.orgRoleDetail.allOrgPermissions": "All organization permissions",
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
  "settings.orgRoleDetail.organizationPermissions": "Organization Permissions",
  "settings.orgRoleDetail.owner": "Owner",
  "settings.orgRoleDetail.ownerMembershipCannotBeChanged":
    "Owner membership cannot be changed",
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
  "settings.orgStore.addRegistry": "Add Registry",
  "settings.orgStore.adding": "Adding...",
  "settings.orgStore.authTokenLabel": "Auth Token",
  "settings.orgStore.authTokenPlaceholder": "Bearer token...",
  "settings.orgStore.cancel": "Cancel",
  "settings.orgStore.communityRegistryDescription":
    "Community MCP registry with thousands of handy MCPs",
  "settings.orgStore.communityRegistryNotAdded":
    "Community MCP registry — not yet added",
  "settings.orgStore.communitySection": "Community",
  "settings.orgStore.connectionNotFound":
    "Connection not found — will be created automatically.",
  "settings.orgStore.decoStoreDescription":
    "Official deco MCP registry with curated integrations",
  "settings.orgStore.decoStoreName": "Deco Store",
  "settings.orgStore.decoStoreSection": "Deco Store",
  "settings.orgStore.failedAddRegistry": "Failed to add registry: {error}",
  "settings.orgStore.failedLoadStoreSettings": "Failed to load store settings:",
  "settings.orgStore.mcpRegistry": "MCP Registry",
  "settings.orgStore.nameLabel": "Name",
  "settings.orgStore.namePlaceholder": "e.g. Acme Corp Registry",
  "settings.orgStore.optional": "Optional",
  "settings.orgStore.pageTitle": "Store",
  "settings.orgStore.privateMcpRegistry": "Private MCP registry",
  "settings.orgStore.privateRegistriesSection": "Private Registries",
  "settings.orgStore.privateRegistry": "Private Registry",
  "settings.orgStore.privateRegistryAdded": "Private registry added",
  "settings.orgStore.privateRegistryDescription":
    "Your organization's private MCP registry",
  "settings.orgStore.registryUrlLabel": "Registry URL",
  "settings.orgStore.registryUrlPlaceholder":
    "https://registry.example.com/mcp",
  "settings.orgStore.remove": "Remove",
  "settings.orgStore.removeRegistry": "Remove this registry?",
  "settings.organizationForm.failedToReadImage": "Failed to read image",
  "settings.organizationForm.failedToUpdateOrg":
    "Failed to update organization",
  "settings.organizationForm.imageTooLarge": "Image must be smaller than 2MB",
  "settings.organizationForm.logoDescription": "Recommended size is 256x256px",
  "settings.organizationForm.logoTitle": "Logo",
  "settings.organizationForm.namePlaceholder": "Organization name",
  "settings.organizationForm.nameTitle": "Name",
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
  "settings.apiKeys.keysCountPlural": "{count} keys",
  "settings.apiKeys.keysCountSingular": "{count} key",
  "settings.apiKeys.nameLabel": "Name",
  "settings.apiKeys.namePlaceholder": "My integration",
  "settings.apiKeys.newKey": "New key",
  "settings.apiKeys.newKeyDescription":
    "Give the key a name so you can recognize it later.",
  "settings.apiKeys.newKeyTitle": "New API key",
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
  "settings.billing.autoTasksTitle": "Auto tasks",
  "settings.billing.unlimitedDescription":
    "Auto-task runs are unlimited on this deployment. Tasks you create yourself are never limited either.",
  "settings.billing.autoTasksDescriptionTrial":
    "3 free lifetime runs, then $50/month for 10 runs per billing cycle.",
  "settings.billing.autoTasksDescriptionSubscribed":
    "10 auto-task runs per billing cycle. Tasks you create yourself are never limited.",
  "settings.billing.statusTrial": "Free trial",
  "settings.billing.statusActive": "Active",
  "settings.billing.statusPastDue": "Payment issue",
  "settings.billing.runsUsedLabel": "runs used",
  "settings.billing.renewsOn": "Renews {date}",
  "settings.billing.subscribeButton": "Subscribe",
  "settings.billing.manageButton": "Manage billing",
  "settings.billing.checkoutError": "Couldn't start checkout: {message}",
  "settings.billing.portalError": "Couldn't open billing portal: {message}",

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
} as const;
