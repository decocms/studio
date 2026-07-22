export const registry = {
  "registry.brokenMcpList.connStatus": "conn",
  "registry.brokenMcpList.connectionLabel": "Connection",
  "registry.brokenMcpList.durationLabel": "Duration",
  "registry.brokenMcpList.failedToolsHeader": "Failed Tools ({count})",
  "registry.brokenMcpList.fullError": "Full Error",
  "registry.brokenMcpList.no": "No",
  "registry.brokenMcpList.noBrokenMcps":
    "No broken MCPs in this run. All healthy! ✓",
  "registry.brokenMcpList.passingTools": "Passing Tools",
  "registry.brokenMcpList.statusFailed": "Failed",
  "registry.brokenMcpList.statusOk": "OK",
  "registry.brokenMcpList.toolsFailed": "{count} tool(s) failed",
  "registry.brokenMcpList.toolsListed": "tools listed",
  "registry.brokenMcpList.toolsListedLabel": "Tools Listed",
  "registry.brokenMcpList.yes": "Yes",
  "registry.csvImportDialog.cancelButton": "Cancel",
  "registry.csvImportDialog.changeFile": "Change file",
  "registry.csvImportDialog.chooseCsvFile": "Choose CSV file",
  "registry.csvImportDialog.description":
    "Upload a CSV file to bulk-import MCP servers into the registry.",
  "registry.csvImportDialog.doneButton": "Done",
  "registry.csvImportDialog.downloadTemplate": "Download template",
  "registry.csvImportDialog.emptyStateHint":
    "Choose a CSV file or download the template to get started.",
  "registry.csvImportDialog.importButton": "Import {count} item(s)",
  "registry.csvImportDialog.importedCount":
    "Imported {count} item(s) successfully",
  "registry.csvImportDialog.importingButton": "Importing...",
  "registry.csvImportDialog.itemsCount": "{count} items",
  "registry.csvImportDialog.linePrefix": "Line {line}:",
  "registry.csvImportDialog.preview": "Preview",
  "registry.csvImportDialog.skippedCount": "{count} skipped",
  "registry.csvImportDialog.tableIdHeader": "ID",
  "registry.csvImportDialog.tableNoValue": "No",
  "registry.csvImportDialog.tableNoneValue": "none",
  "registry.csvImportDialog.tablePublicHeader": "Public",
  "registry.csvImportDialog.tableTagsHeader": "Tags",
  "registry.csvImportDialog.tableTitleHeader": "Title",
  "registry.csvImportDialog.tableUrlHeader": "Remote URL",
  "registry.csvImportDialog.tableYesValue": "Yes",
  "registry.csvImportDialog.title": "Import MCP Servers from CSV",
  "registry.deleteConfirmDialog.cancel": "Cancel",
  "registry.deleteConfirmDialog.delete": "Delete",
  "registry.deleteConfirmDialog.deleting": "Deleting...",
  "registry.deleteConfirmDialog.description":
    "This action cannot be undone. Item {title} will be permanently removed from this private registry.",
  "registry.deleteConfirmDialog.title": "Delete registry item?",
  "registry.imageUpload.change": "Change",
  "registry.imageUpload.clickOrDragToUpload": "Click or drag to upload",
  "registry.imageUpload.dropImageHere": "Drop image here",
  "registry.imageUpload.image": "Image",
  "registry.imageUpload.orPasteImageUrl": "Or paste an image URL",
  "registry.imageUpload.previewAlt": "Preview",
  "registry.imageUpload.remove": "Remove",
  "registry.imageUpload.supportedFormats": "PNG, JPG, SVG up to 2MB",
  "registry.imageUpload.uploadingImage": "Uploading image...",
  "registry.imageUpload.urlPlaceholder": "https://example.com/logo.png",
  "registry.monitorConfiguration.aboutLabel": "About {label}",
  "registry.monitorConfiguration.additionalTestContextHint":
    "Extra runtime context passed to the agent, such as valid emails, tenant IDs, or known test entities.",
  "registry.monitorConfiguration.additionalTestContextLabel":
    "Additional test context (prompt)",
  "registry.monitorConfiguration.agentContextHelper":
    "Use this field for real data required by some tools (valid email, fixed IDs, test environment details, etc).",
  "registry.monitorConfiguration.agentContextPlaceholder":
    'Example: Use "my-user@company.com" as a valid email for Google Drive share/create_permission tests.',
  "registry.monitorConfiguration.defaultSystemPrompt": "default system prompt",
  "registry.monitorConfiguration.description":
    "Configure how the MCP QA agent validates registry entries.",
  "registry.monitorConfiguration.hideDefaultPrompt": "Hide",
  "registry.monitorConfiguration.includePendingRequests":
    "Include pending requests in tests",
  "registry.monitorConfiguration.maxAgentStepsHint":
    "Maximum number of reasoning/tool steps in Agentic mode.",
  "registry.monitorConfiguration.maxAgentStepsLabel": "Max agent steps",
  "registry.monitorConfiguration.onFailureHint":
    "Automatic action to apply when an MCP fails tests in a run.",
  "registry.monitorConfiguration.onFailureLabel": "On failure",
  "registry.monitorConfiguration.onFailureNone": "Do nothing",
  "registry.monitorConfiguration.onFailureRemoveAll":
    "Remove from all (public + private)",
  "registry.monitorConfiguration.onFailureRemovePrivate":
    "Remove from private registry",
  "registry.monitorConfiguration.onFailureRemovePublic":
    "Remove from public store",
  "registry.monitorConfiguration.onFailureUnlisted":
    "Unlist from store (keep in registry)",
  "registry.monitorConfiguration.perMcpTimeoutHint":
    "Max total time allowed to validate one MCP.",
  "registry.monitorConfiguration.perMcpTimeoutLabel": "Per MCP timeout (ms)",
  "registry.monitorConfiguration.perToolTimeoutHint":
    "Max time allowed for each individual tool call.",
  "registry.monitorConfiguration.perToolTimeoutLabel": "Per tool timeout (ms)",
  "registry.monitorConfiguration.privateOnly": "Private only",
  "registry.monitorConfiguration.publicOnly": "Public only",
  "registry.monitorConfiguration.publishRequestsHint":
    "Include pending publish requests in QA runs to validate them before publishing to the store.",
  "registry.monitorConfiguration.publishRequestsLabel": "Publish requests",
  "registry.monitorConfiguration.qaConfiguration": "QA Configuration",
  "registry.monitorConfiguration.saveSettings": "Save settings",
  "registry.monitorConfiguration.saved": "Saved",
  "registry.monitorConfiguration.saving": "Saving...",
  "registry.monitorConfiguration.testScopeHint":
    "Choose whether tests should run for public items, private items, or both.",
  "registry.monitorConfiguration.testScopeLabel": "Test scope",
  "registry.monitorConfiguration.unsavedChanges": "Unsaved changes",
  "registry.monitorConfiguration.viewDefaultPrompt": "View",
  "registry.monitorConnectionsPanel.actionsFor": "Actions for {title}",
  "registry.monitorConnectionsPanel.authError": "Error: {error}",
  "registry.monitorConnectionsPanel.authenticated": "Authenticated",
  "registry.monitorConnectionsPanel.checking": "Checking...",
  "registry.monitorConnectionsPanel.checkingAuth": "Checking auth...",
  "registry.monitorConnectionsPanel.connected": "Connected",
  "registry.monitorConnectionsPanel.connectionAuthenticated":
    '"{title}" authenticated!',
  "registry.monitorConnectionsPanel.connectionReachable":
    '"{title}" is reachable. You can re-authenticate if needed.',
  "registry.monitorConnectionsPanel.connectionsSynced":
    "Connections synced (store + pending requests)",
  "registry.monitorConnectionsPanel.couldNotReachConnection":
    'Could not reach "{title}". The remote MCP may be down.',
  "registry.monitorConnectionsPanel.description1":
    "We auto-detect auth type. Use OAuth when available, or always paste a Token/API key for manual auth MCPs.",
  "registry.monitorConnectionsPanel.description2":
    "Listing tools alone does not imply authenticated status.",
  "registry.monitorConnectionsPanel.description3":
    "Cards show MCP icon, auth status, and latest failed test counters.",
  "registry.monitorConnectionsPanel.edit": "Edit",
  "registry.monitorConnectionsPanel.errorSavingToken":
    "Error saving token: {error}",
  "registry.monitorConnectionsPanel.failedCount":
    "{mcpCount} failed MCP / {toolsCount} failed tools",
  "registry.monitorConnectionsPanel.failedToSaveAuthStatus":
    'Failed to save auth status for "{title}": {error}',
  "registry.monitorConnectionsPanel.failedToSaveOAuthTokens":
    'Failed to save OAuth tokens for "{title}".',
  "registry.monitorConnectionsPanel.failedToUpdateVisibility":
    "Failed to update visibility",
  "registry.monitorConnectionsPanel.filterAll": "All",
  "registry.monitorConnectionsPanel.filterRequests": "Requests",
  "registry.monitorConnectionsPanel.filterStore": "Store",
  "registry.monitorConnectionsPanel.hiddenInPrivate": "Hidden in private",
  "registry.monitorConnectionsPanel.hideFromPrivateStore":
    "Hide from private store",
  "registry.monitorConnectionsPanel.hideFromPublicStore":
    "Hide from public store",
  "registry.monitorConnectionsPanel.loadFailed":
    "Failed to load QA connections.",
  "registry.monitorConnectionsPanel.loadingConnections":
    "Loading QA connections...",
  "registry.monitorConnectionsPanel.needsAuth": "Needs Auth",
  "registry.monitorConnectionsPanel.noConnectionsForFilter":
    'No QA connections for this filter. Click "Sync" to create mappings from store items and pending requests.',
  "registry.monitorConnectionsPanel.noOAuthSupport":
    '"{title}" does not support OAuth. Use the Token field to paste an API key.',
  "registry.monitorConnectionsPanel.notChecked": "Not checked",
  "registry.monitorConnectionsPanel.notPublic": "Not public",
  "registry.monitorConnectionsPanel.oauth": "OAuth",
  "registry.monitorConnectionsPanel.oauthAvailable": "OAuth available",
  "registry.monitorConnectionsPanel.oauthConnected": "OAuth connected",
  "registry.monitorConnectionsPanel.oauthFailed":
    'OAuth failed for "{title}": {error}',
  "registry.monitorConnectionsPanel.openingAuthWindow":
    'Opening authentication window for "{title}"...',
  "registry.monitorConnectionsPanel.pasteApiTokenPlaceholder":
    "Paste API token / key...",
  "registry.monitorConnectionsPanel.public": "Public",
  "registry.monitorConnectionsPanel.reAuthOAuth": "Re-auth OAuth",
  "registry.monitorConnectionsPanel.reCheck": "Re-check",
  "registry.monitorConnectionsPanel.registryItemNotFound":
    "Registry item not found for this connection.",
  "registry.monitorConnectionsPanel.replaceToken": "Replace token",
  "registry.monitorConnectionsPanel.request": "Request",
  "registry.monitorConnectionsPanel.requestItemNoControls":
    "Request item (no store visibility controls)",
  "registry.monitorConnectionsPanel.save": "Save",
  "registry.monitorConnectionsPanel.serverError": "Server error",
  "registry.monitorConnectionsPanel.serverErrorConnection":
    'Server error for "{title}". The remote MCP may be down.',
  "registry.monitorConnectionsPanel.showInBothStores": "Show in both stores",
  "registry.monitorConnectionsPanel.store": "Store",
  "registry.monitorConnectionsPanel.sync": "Sync",
  "registry.monitorConnectionsPanel.syncFailed": "Sync failed: {error}",
  "registry.monitorConnectionsPanel.syncing": "Syncing...",
  "registry.monitorConnectionsPanel.title": "QA Connections",
  "registry.monitorConnectionsPanel.tokenApiKeyDescription":
    "Token/API key (for MCPs that require manual auth)",
  "registry.monitorConnectionsPanel.tokenCannotBeEmpty":
    "Token cannot be empty.",
  "registry.monitorConnectionsPanel.tokenManualAuth": "Token/manual auth",
  "registry.monitorConnectionsPanel.tokenSaved": 'Token saved for "{title}"!',
  "registry.monitorConnectionsPanel.unknownError": "Unknown error",
  "registry.monitorConnectionsPanel.visibilityOnlyForStore":
    "Visibility controls are available only for store items.",
  "registry.monitorConnectionsPanel.visibilityUpdated": "Visibility updated",
  "registry.monitorDashboard.autoSelectLatestRun": "Auto-select latest run",
  "registry.monitorDashboard.cancelButton": "Cancel",
  "registry.monitorDashboard.cancelButtonDialog": "Cancel",
  "registry.monitorDashboard.confirmStartDescription":
    "There is already a run in progress{runId}. Starting another run may increase database load and slow down both executions.",
  "registry.monitorDashboard.confirmStartTitle": "Start another test run?",
  "registry.monitorDashboard.connFailTitle": "Connection failed",
  "registry.monitorDashboard.connOkTitle": "Connection OK",
  "registry.monitorDashboard.connectionLabel": "Connection:",
  "registry.monitorDashboard.currentQaRunDescription":
    "Start a full QA validation run and track results in real time.",
  "registry.monitorDashboard.currentQaRunTitle": "Current QA Run",
  "registry.monitorDashboard.errorLabel": "Error",
  "registry.monitorDashboard.failedLabel": "Failed",
  "registry.monitorDashboard.inputLabel": "Input",
  "registry.monitorDashboard.itemsTestedCount": "{tested}/{total} tested",
  "registry.monitorDashboard.modeAgentic": "Agentic (LLM model)",
  "registry.monitorDashboard.modeBadge": "mode: {mode}",
  "registry.monitorDashboard.modeDescriptionAgentic":
    "Uses an LLM model to execute chained tool calls and validate outputs.",
  "registry.monitorDashboard.modeDescriptionHealthCheck":
    "Checks connectivity and tool listing only — no tool calls are made.",
  "registry.monitorDashboard.modeDescriptionToolCall":
    "Calls each tool with empty inputs to verify it responds without errors.",
  "registry.monitorDashboard.modeHealthCheck": "Health check",
  "registry.monitorDashboard.modeToolCall": "Tool call",
  "registry.monitorDashboard.no": "No",
  "registry.monitorDashboard.noResultsYetMessage":
    "No results yet. Start a run to see live logs here.",
  "registry.monitorDashboard.noRunSelectedMessage":
    "No run selected yet. Start a new run to begin.",
  "registry.monitorDashboard.noTools": "0 tools",
  "registry.monitorDashboard.noToolsFound": "No tools found on this server.",
  "registry.monitorDashboard.noToolsLabel": "no tools",
  "registry.monitorDashboard.outputLabel": "Output",
  "registry.monitorDashboard.passedLabel": "Passed",
  "registry.monitorDashboard.progressBadge":
    "progress: {tested} of {total} MCPs",
  "registry.monitorDashboard.qaModeLabel": "QA mode",
  "registry.monitorDashboard.qaOnLabel": "QA on:",
  "registry.monitorDashboard.qaResultsLogDescription":
    "Live per-MCP test output for the selected run.",
  "registry.monitorDashboard.qaResultsLogTitle": "QA results log ({count})",
  "registry.monitorDashboard.qaRunHistoryLabel":
    "QA run history (pick a previous run)",
  "registry.monitorDashboard.runInProgressBadge": "Run in progress: {runId}",
  "registry.monitorDashboard.runInProgressLabel": "run in progress",
  "registry.monitorDashboard.skippedLabel": "Skipped",
  "registry.monitorDashboard.startAnotherRunButton": "Start another run",
  "registry.monitorDashboard.startAnywayButton": "Start anyway",
  "registry.monitorDashboard.startQaRunButton": "Start QA run",
  "registry.monitorDashboard.startingButton": "Starting...",
  "registry.monitorDashboard.statusFailed": "Failed",
  "registry.monitorDashboard.statusOk": "OK",
  "registry.monitorDashboard.toolsDiscoveredHealthCheck":
    "Tools discovered ({count}) - not individually tested (health-check mode)",
  "registry.monitorDashboard.toolsFoundCount": "{count} tools found",
  "registry.monitorDashboard.toolsListedLabel": "Tools listed:",
  "registry.monitorDashboard.toolsTestedCount":
    "{tested}/{discovered} tools tested",
  "registry.monitorDashboard.toolsTestedDetails":
    "Tools tested: {passed} passed, {failed} failed",
  "registry.monitorDashboard.totalLabel": "Total",
  "registry.monitorDashboard.yes": "Yes",
  "registry.monitorRunDetail.action": "action",
  "registry.monitorRunDetail.actionTaken": "Action Taken",
  "registry.monitorRunDetail.agentSummary": "Agent Summary",
  "registry.monitorRunDetail.conn": "conn",
  "registry.monitorRunDetail.connected": "Connected",
  "registry.monitorRunDetail.connection": "Connection",
  "registry.monitorRunDetail.duration": "Duration",
  "registry.monitorRunDetail.durationLabel": "Duration",
  "registry.monitorRunDetail.error": "Error",
  "registry.monitorRunDetail.errorMessage": "Error Message",
  "registry.monitorRunDetail.failed": "Failed",
  "registry.monitorRunDetail.filterAll": "All",
  "registry.monitorRunDetail.filterError": "Error",
  "registry.monitorRunDetail.filterFailed": "Failed",
  "registry.monitorRunDetail.filterNeedsAuth": "Needs Auth",
  "registry.monitorRunDetail.filterPassed": "Passed",
  "registry.monitorRunDetail.filterSkipped": "Skipped",
  "registry.monitorRunDetail.finished": "Finished",
  "registry.monitorRunDetail.input": "Input",
  "registry.monitorRunDetail.no": "No",
  "registry.monitorRunDetail.noAdditionalDetails": "No additional details.",
  "registry.monitorRunDetail.noResultsMatchFilter":
    "No results match the current filter.",
  "registry.monitorRunDetail.noTestResultsYet": "No test results yet.",
  "registry.monitorRunDetail.outputPreview": "Output preview",
  "registry.monitorRunDetail.passed": "Passed",
  "registry.monitorRunDetail.refresh": "Refresh",
  "registry.monitorRunDetail.result": "result(s)",
  "registry.monitorRunDetail.runDetail": "Run Detail",
  "registry.monitorRunDetail.selectRunToInspect":
    "Select a run to inspect details.",
  "registry.monitorRunDetail.skipped": "Skipped",
  "registry.monitorRunDetail.started": "Started",
  "registry.monitorRunDetail.tested": "Tested",
  "registry.monitorRunDetail.toolResults":
    "Tool Results ({passed} passed, {failed} failed)",
  "registry.monitorRunDetail.tools": "tools",
  "registry.monitorRunDetail.toolsDiscovered":
    "Tools discovered ({count}) — not individually tested (health-check mode)",
  "registry.monitorRunDetail.toolsFound": "tools found",
  "registry.monitorRunDetail.toolsListed": "tools listed",
  "registry.monitorRunDetail.toolsListedLabel": "Tools Listed",
  "registry.monitorRunDetail.total": "Total",
  "registry.monitorRunDetail.yesWithCount": "Yes ({count})",
  "registry.registryItemCard.actionsFor": "Actions for {title}",
  "registry.registryItemCard.delete": "Delete",
  "registry.registryItemCard.edit": "Edit",
  "registry.registryItemCard.markAsOfficial": "Mark as Official",
  "registry.registryItemCard.markAsVerified": "Mark as Verified",
  "registry.registryItemCard.noDescriptionProvided": "No description provided.",
  "registry.registryItemCard.official": "Official",
  "registry.registryItemCard.private": "Private",
  "registry.registryItemCard.public": "Public",
  "registry.registryItemCard.unmarkAsOfficial": "Unmark as Official",
  "registry.registryItemCard.unmarkAsVerified": "Unmark as Verified",
  "registry.registryItemCard.verified": "Verified",
  "registry.registryItemDialog.addMcpServer": "Add MCP Server",
  "registry.registryItemDialog.advanced": "Advanced",
  "registry.registryItemDialog.andMore": "+{count} more",
  "registry.registryItemDialog.authRequiredMessage":
    "This server requires authentication. The connection is valid but tools cannot be listed without credentials.",
  "registry.registryItemDialog.back": "Back",
  "registry.registryItemDialog.briefDescription":
    "Brief description of this MCP server",
  "registry.registryItemDialog.cancel": "Cancel",
  "registry.registryItemDialog.category": "Category",
  "registry.registryItemDialog.clear": "clear",
  "registry.registryItemDialog.content": "Content",
  "registry.registryItemDialog.create": "Create",
  "registry.registryItemDialog.createCategory": 'Create "{value}"',
  "registry.registryItemDialog.createTag": 'Create "{value}"',
  "registry.registryItemDialog.curatedAndApproved":
    "Curated and approved by deco.",
  "registry.registryItemDialog.description": "Description",
  "registry.registryItemDialog.descriptionMaxLength":
    "Description must be 1500 characters or less.",
  "registry.registryItemDialog.details": "Details",
  "registry.registryItemDialog.discoverToolsFromUrl": "Discover tools from URL",
  "registry.registryItemDialog.discoveringTools": "Discovering tools...",
  "registry.registryItemDialog.editMcpServer": "Edit MCP Server",
  "registry.registryItemDialog.essentials": "Essentials",
  "registry.registryItemDialog.failedToUploadImage":
    "Failed to upload image. Please try again.",
  "registry.registryItemDialog.imageUrlIsInvalid": "Image URL is invalid.",
  "registry.registryItemDialog.imageUrlMustBeHttps":
    "Image URL must be http(s).",
  "registry.registryItemDialog.itemId": "Item ID:",
  "registry.registryItemDialog.link": "Link",
  "registry.registryItemDialog.madeAndHostedByServiceProvider":
    "Made and hosted by the service provider.",
  "registry.registryItemDialog.makeThisMcpVisible":
    "Make this MCP visible in the public store URL.",
  "registry.registryItemDialog.name": "Name",
  "registry.registryItemDialog.nameIsRequired": "Name is required.",
  "registry.registryItemDialog.nameMustContainValidCharacters":
    "Name must contain valid characters.",
  "registry.registryItemDialog.next": "Next",
  "registry.registryItemDialog.official": "Official",
  "registry.registryItemDialog.ownerOptional": "Owner (optional)",
  "registry.registryItemDialog.provider": "Provider",
  "registry.registryItemDialog.providerIsRequired": "Provider is required.",
  "registry.registryItemDialog.public": "Public",
  "registry.registryItemDialog.readme": "README",
  "registry.registryItemDialog.readmeMaxLength":
    "README must be 50 000 characters or less.",
  "registry.registryItemDialog.readmeUrlIsInvalid": "README URL is invalid.",
  "registry.registryItemDialog.readmeUrlMustBeHttps":
    "README URL must be http(s).",
  "registry.registryItemDialog.rediscoverTools": "Re-discover tools",
  "registry.registryItemDialog.remoteTypeMustBe":
    "Remote type must be: http, sse or stdio.",
  "registry.registryItemDialog.remoteUrl": "Remote URL",
  "registry.registryItemDialog.remoteUrlIsInvalid": "Remote URL is invalid.",
  "registry.registryItemDialog.remoteUrlMustBeHttps":
    "Remote URL must be http(s).",
  "registry.registryItemDialog.repositoryUrlIsInvalid":
    "Repository URL is invalid.",
  "registry.registryItemDialog.repositoryUrlMustBeHttps":
    "Repository URL must be http(s).",
  "registry.registryItemDialog.repositoryUrlOptional":
    "Repository URL (optional)",
  "registry.registryItemDialog.saveChanges": "Save changes",
  "registry.registryItemDialog.saving": "Saving...",
  "registry.registryItemDialog.selectOrCreateCategory":
    "Select or create category",
  "registry.registryItemDialog.shortDescription": "Short Description",
  "registry.registryItemDialog.shortDescriptionMaxLength":
    "Short description must be 160 characters or less.",
  "registry.registryItemDialog.shortSummaryForStoreCard":
    "Short summary for the store card",
  "registry.registryItemDialog.step1Description":
    "Set up the identity, connection and discover available tools.",
  "registry.registryItemDialog.step2Description":
    "Add descriptions, categories and tags to help discovery.",
  "registry.registryItemDialog.step3Description":
    "Configure optional metadata, README and tools.",
  "registry.registryItemDialog.tags": "Tags",
  "registry.registryItemDialog.teamCompanyOrPerson":
    "Team, company, or responsible person",
  "registry.registryItemDialog.toolsDiscovered": "{count} tool(s) discovered",
  "registry.registryItemDialog.toolsLoaded": "{count} tool(s) loaded",
  "registry.registryItemDialog.toolsWillEnrich":
    "These tools will enrich AI-generated descriptions, tags and categories in the next step.",
  "registry.registryItemDialog.type": "Type",
  "registry.registryItemDialog.typeAndPressEnter":
    "Type and press Enter or comma",
  "registry.registryItemDialog.typeToSearchOrCreate":
    "Type to search or create.",
  "registry.registryItemDialog.useValidIdFormat":
    "Use lowercase letters/numbers and separators '/' or '-'.",
  "registry.registryItemDialog.verified": "Verified",
  "registry.registryItemsPage.actions": "Actions",
  "registry.registryItemsPage.actionsFor": "Actions for {title}",
  "registry.registryItemsPage.addFirstMcpItem":
    "Add your first MCP item to start building your private registry catalog.",
  "registry.registryItemsPage.addMcpServers": "Add MCP Servers",
  "registry.registryItemsPage.cards": "Cards",
  "registry.registryItemsPage.cardsViewAriaLabel": "Cards view",
  "registry.registryItemsPage.categories": "Categories",
  "registry.registryItemsPage.clearFilters": "Clear filters",
  "registry.registryItemsPage.delete": "Delete",
  "registry.registryItemsPage.edit": "Edit",
  "registry.registryItemsPage.failedToDeleteItem": "Failed to delete item",
  "registry.registryItemsPage.failedToImportCsv": "Failed to import CSV",
  "registry.registryItemsPage.failedToSaveItem": "Failed to save item",
  "registry.registryItemsPage.failedToUpdateItem": "Failed to update item",
  "registry.registryItemsPage.filters": "Filters",
  "registry.registryItemsPage.icon": "Icon",
  "registry.registryItemsPage.id": "ID",
  "registry.registryItemsPage.importCsv": "Import CSV",
  "registry.registryItemsPage.importedItems": "Imported {count} item(s)",
  "registry.registryItemsPage.items": "Items",
  "registry.registryItemsPage.loadingItems": "Loading items...",
  "registry.registryItemsPage.loadingMoreItems": "Loading more items...",
  "registry.registryItemsPage.markedAsOfficial": "Marked as official",
  "registry.registryItemsPage.markedAsVerified": "Marked as verified",
  "registry.registryItemsPage.noCategoriesAvailable": "No categories available",
  "registry.registryItemsPage.noItemsFound": "No items found",
  "registry.registryItemsPage.noMcpsInRegistry": "No MCPs in your registry",
  "registry.registryItemsPage.noTagsAvailable": "No tags available",
  "registry.registryItemsPage.private": "Private",
  "registry.registryItemsPage.public": "Public",
  "registry.registryItemsPage.registryItemCreated": "Registry item created",
  "registry.registryItemsPage.registryItemDeleted": "Registry item deleted",
  "registry.registryItemsPage.registryItemUpdated": "Registry item updated",
  "registry.registryItemsPage.remoteUrl": "Remote URL",
  "registry.registryItemsPage.removedOfficialStatus": "Removed official status",
  "registry.registryItemsPage.removedVerifiedStatus": "Removed verified status",
  "registry.registryItemsPage.searchPlaceholder":
    "Search by id, title, description, or server name",
  "registry.registryItemsPage.table": "Table",
  "registry.registryItemsPage.tableViewAriaLabel": "Table view",
  "registry.registryItemsPage.tags": "Tags",
  "registry.registryItemsPage.title": "Title",
  "registry.registryItemsPage.tryRemovingFilters":
    "Try removing filters or changing your search to find matching MCPs.",
  "registry.registryItemsPage.visibility": "Visibility",
  "registry.registryLayout.itemsTab": "Items",
  "registry.registryLayout.qaTab": "QA",
  "registry.registryLayout.requestsTab": "Requests",
  "registry.registryLayout.settingsTab": "Settings",
  "registry.registryMonitorPage.brokenMcps": "Broken MCPs",
  "registry.registryMonitorPage.tabConfiguration": "Configuration",
  "registry.registryMonitorPage.tabConnections": "Connections",
  "registry.registryMonitorPage.tabTests": "Tests",
  "registry.registryRequestsPage.approvePublishRequestDesc":
    "This will add {title} to your private registry. The requester will be notified of the approval.",
  "registry.registryRequestsPage.approvePublishRequestTitle":
    "Approve publish request?",
  "registry.registryRequestsPage.approveSelected": "Approve selected",
  "registry.registryRequestsPage.approveSelectedRequestsDesc":
    "This will approve {count} request(s) and create all resulting apps with the same visibility setting.",
  "registry.registryRequestsPage.approveSelectedRequestsTitle":
    "Approve selected requests?",
  "registry.registryRequestsPage.approving": "Approving...",
  "registry.registryRequestsPage.bulkApproveFailed":
    "Bulk approve failed. Selected items were kept for retry.",
  "registry.registryRequestsPage.bulkApprovePartial":
    "Approved {approvedCount}. Failed {failedCount}. Failed items remain selected for retry.",
  "registry.registryRequestsPage.bulkApproveSuccess":
    "{approvedCount} request(s) approved as {bulkVisibility}.",
  "registry.registryRequestsPage.buttonApprove": "Approve",
  "registry.registryRequestsPage.buttonCancel": "Cancel",
  "registry.registryRequestsPage.buttonClose": "Close",
  "registry.registryRequestsPage.buttonDelete": "Delete",
  "registry.registryRequestsPage.buttonReject": "Reject",
  "registry.registryRequestsPage.buttonView": "View",
  "registry.registryRequestsPage.clearSelection": "Clear selection",
  "registry.registryRequestsPage.columnActions": "Actions",
  "registry.registryRequestsPage.columnDate": "Date",
  "registry.registryRequestsPage.columnName": "Name",
  "registry.registryRequestsPage.columnRequester": "Requester",
  "registry.registryRequestsPage.columnStatus": "Status",
  "registry.registryRequestsPage.columnTags": "Tags",
  "registry.registryRequestsPage.failedLoadRequests":
    "Failed to load publish requests.",
  "registry.registryRequestsPage.itemAlreadyExists":
    "An item with this ID already exists in the registry. Delete or rename it first.",
  "registry.registryRequestsPage.labelCategories": "Categories",
  "registry.registryRequestsPage.labelDescription": "Description",
  "registry.registryRequestsPage.labelEmail": "Email",
  "registry.registryRequestsPage.labelREADME": "README",
  "registry.registryRequestsPage.labelRemoteURL": "Remote URL",
  "registry.registryRequestsPage.labelRequester": "Requester",
  "registry.registryRequestsPage.labelStatus": "Status",
  "registry.registryRequestsPage.labelSubmitted": "Submitted",
  "registry.registryRequestsPage.labelTags": "Tags",
  "registry.registryRequestsPage.loadingMoreRequests":
    "Loading more requests...",
  "registry.registryRequestsPage.loadingRequests": "Loading requests...",
  "registry.registryRequestsPage.noApprovedRequests":
    "No approved publish requests.",
  "registry.registryRequestsPage.noDescriptionProvided":
    "No description provided.",
  "registry.registryRequestsPage.noPendingRequests":
    "No pending publish requests.",
  "registry.registryRequestsPage.noREADMEProvided": "No README provided.",
  "registry.registryRequestsPage.noRejectedRequests":
    "No rejected publish requests.",
  "registry.registryRequestsPage.openREADMELink": "Open README link",
  "registry.registryRequestsPage.reasonForRejectionPlaceholder":
    "Reason for rejection...",
  "registry.registryRequestsPage.rejectPublishRequestDesc":
    "This request will move to rejected status. You can leave optional notes for context.",
  "registry.registryRequestsPage.rejectPublishRequestTitle":
    "Reject publish request?",
  "registry.registryRequestsPage.rejecting": "Rejecting...",
  "registry.registryRequestsPage.requestApprovedAndAdded":
    "Request approved and added to registry",
  "registry.registryRequestsPage.requestDeleted": "Request deleted",
  "registry.registryRequestsPage.requestDetails": "Request details",
  "registry.registryRequestsPage.requestRejected": "Request rejected",
  "registry.registryRequestsPage.requestsToPublish": "Requests to Publish",
  "registry.registryRequestsPage.reviewMetadataDescription":
    "Review all metadata sent by the requester before approving.",
  "registry.registryRequestsPage.reviewerNotes": "Reviewer notes (optional)",
  "registry.registryRequestsPage.selectAll": "Select all",
  "registry.registryRequestsPage.selected": "Selected",
  "registry.registryRequestsPage.selectedCount": "{selectedCount} selected",
  "registry.registryRequestsPage.sortAlphaAZ": "Alphabetical (A-Z)",
  "registry.registryRequestsPage.sortAlphaZA": "Alphabetical (Z-A)",
  "registry.registryRequestsPage.sortCreatedNewest":
    "Created at (newest first)",
  "registry.registryRequestsPage.sortCreatedOldest":
    "Created at (oldest first)",
  "registry.registryRequestsPage.statusApproved": "Approved",
  "registry.registryRequestsPage.statusPending": "Pending",
  "registry.registryRequestsPage.statusRejected": "Rejected",
  "registry.registryRequestsPage.unknownError": "Unknown error",
  "registry.registryRequestsPage.visibilityForAll":
    "Visibility for all selected",
  "registry.registryRequestsPage.visibilityPrivate": "Private",
  "registry.registryRequestsPage.visibilityPublic": "Public",
  "registry.registrySettingsPage.apiKeyGenerated":
    "API key generated. Copy it now — it won't be shown again!",
  "registry.registrySettingsPage.apiKeyRevoked": "API key revoked",
  "registry.registrySettingsPage.apiKeys": "API Keys",
  "registry.registrySettingsPage.cancel": "Cancel",
  "registry.registrySettingsPage.configureNameIcon":
    "Configure the name and icon shown in the store selector.",
  "registry.registrySettingsPage.failedGenerateApiKey":
    "Failed to generate API key",
  "registry.registrySettingsPage.failedRevokeApiKey":
    "Failed to revoke API key",
  "registry.registrySettingsPage.failedUploadIcon":
    "Failed to upload icon. Please try again.",
  "registry.registrySettingsPage.generate": "Generate",
  "registry.registrySettingsPage.keyName": "Key name",
  "registry.registrySettingsPage.keyNamePlaceholder": "e.g. CI/CD Pipeline",
  "registry.registrySettingsPage.maxRequests": "Max requests",
  "registry.registrySettingsPage.maxRequestsPlaceholder": "100",
  "registry.registrySettingsPage.name": "Name",
  "registry.registrySettingsPage.namePlaceholder": "Private Registry",
  "registry.registrySettingsPage.newKeyRefreshing":
    "New key (refreshing list...)",
  "registry.registrySettingsPage.perHour": "Per hour",
  "registry.registrySettingsPage.perMinute": "Per minute",
  "registry.registrySettingsPage.publicItem": "public item",
  "registry.registrySettingsPage.publicItems": "public items",
  "registry.registrySettingsPage.publicRegistry": "Public Registry",
  "registry.registrySettingsPage.publicRegistryDescription":
    "Public URL to consume this registry as an MCP.",
  "registry.registrySettingsPage.publishRequests": "Publish Requests",
  "registry.registrySettingsPage.publishRequestsDescription":
    "Allow external users to submit MCP servers for review.",
  "registry.registrySettingsPage.rateLimit": "Rate Limit",
  "registry.registrySettingsPage.rateLimitHelp":
    "Limit publish requests per organization by time window.",
  "registry.registrySettingsPage.registryIdentity": "Registry Identity",
  "registry.registrySettingsPage.requireApiToken": "Require API Token",
  "registry.registrySettingsPage.requireApiTokenHelp":
    "Requests without a valid token will be rejected.",
  "registry.registrySettingsPage.revokeApiKeyDescription":
    'This action cannot be undone. The key{keyName ? ` "{keyName}"` : ""} will stop working immediately.',
  "registry.registrySettingsPage.revokeApiKeyTitle": "Revoke API key?",
  "registry.registrySettingsPage.revokeKey": "Revoke key",
  "registry.registrySettingsPage.revoking": "Revoking...",
  "registry.registrySettingsPage.storeVisibility": "Store Visibility",
  "registry.registrySettingsPage.storeVisibilityDescription":
    "Choose what appears when users browse this registry in Store.",
  "registry.registrySettingsPage.storeVisibilityHelp":
    "Enabled: show only private apps. Disabled: show public and private apps together.",
  "registry.registrySettingsPage.window": "Window",
  "registry.toolsEditor.autoDiscover": "Auto-discover",
  "registry.toolsEditor.clear": "Clear",
  "registry.toolsEditor.discoveredSuccess":
    "Discovered {count} tool(s) successfully.",
  "registry.toolsEditor.discovering": "Discovering...",
  "registry.toolsEditor.emptyHintWithUrl":
    'Click "Auto-discover" to load tools from the MCP server.',
  "registry.toolsEditor.emptyHintWithoutUrl":
    "Add a Remote URL first, then tools can be auto-discovered.",
  "registry.toolsEditor.refresh": "Refresh",
  "registry.toolsEditor.tools": "Tools",
} as const;
