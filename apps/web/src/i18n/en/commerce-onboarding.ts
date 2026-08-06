export const commerceOnboarding = {
  "commerceOnboarding.companionCard.configure": "Configure",
  "commerceOnboarding.companionCard.configureAriaLabel": "Configure {title}",
  "commerceOnboarding.companionCard.configureDescription":
    "Configure {title} to enrich the data",
  "commerceOnboarding.companionCard.connect": "Connect",
  "commerceOnboarding.companionCard.connectAriaLabel": "Connect {title}",
  "commerceOnboarding.companionCard.connected": "Connected",
  "commerceOnboarding.companionCard.disconnect": "Disconnect",
  "commerceOnboarding.companionCard.disconnectAriaLabel": "Disconnect {title}",
  "commerceOnboarding.companionCard.disconnectError":
    "Couldn't disconnect. Please try again.",
  "commerceOnboarding.companionCard.disconnectedSuccess":
    "{title} disconnected",
  "commerceOnboarding.companionCard.editConfiguration": "Edit configuration",
  "commerceOnboarding.companionCard.finishSetup": "Finish setup",
  "commerceOnboarding.companionCard.required": "Required",
  "commerceOnboarding.githubConfigForm.cancel": "Cancel",
  "commerceOnboarding.githubConfigForm.failedToSave":
    "Couldn't save the configuration",
  "commerceOnboarding.githubConfigForm.githubConnectionNotFound":
    "GitHub connection not found.",
  "commerceOnboarding.githubConfigForm.invalidRepository":
    'Invalid repository: "{repo}". Use the owner/name format.',
  "commerceOnboarding.githubConfigForm.loadingRepositories":
    "Loading repositories...",
  "commerceOnboarding.githubConfigForm.noGithubInstallation":
    'No GitHub installation found for "{owner}".',
  "commerceOnboarding.githubConfigForm.noRepositoriesFound":
    "No repositories found. Type the repository name (owner/name) to search.",
  "commerceOnboarding.githubConfigForm.save": "Save",
  "commerceOnboarding.githubConfigForm.saving": "Saving...",
  "commerceOnboarding.githubConfigForm.searchFailedPartial":
    "Part of the search failed — some repositories may be missing. Try again or type owner/name.",
  "commerceOnboarding.githubConfigForm.searchFailedTotal":
    "Couldn't search the repositories (error or timeout). Try again or type the repository as owner/name.",
  "commerceOnboarding.githubConfigForm.searchRepositoryLabel":
    "Search repository",
  "commerceOnboarding.githubConfigForm.searchRepositoryPlaceholder":
    "Search repository",
  "commerceOnboarding.githubConfigForm.selectRepository": "Select a repository",
  "commerceOnboarding.saBindingForm.bind": "Connect",
  "commerceOnboarding.saBindingForm.bindError": "Couldn't connect.",
  "commerceOnboarding.saBindingForm.cancel": "Cancel",
  "commerceOnboarding.saBindingForm.connectedSuccess": "{label} connected",
  "commerceOnboarding.saBindingForm.copyEmailLabel":
    "Copy the reader account e-mail",
  "commerceOnboarding.saBindingForm.emailCopied": "E-mail copied",
  "commerceOnboarding.saBindingForm.googleLoginAlternative":
    "Sign in with Google instead",
  "commerceOnboarding.saBindingForm.resourceIdRequired":
    "Provide the {resourceLabel}",
  "commerceOnboarding.saBindingForm.storeUrlUnavailable":
    "Store URL unavailable. Reload the page.",
  "commerceOnboarding.saBindingForm.verifying": "Verifying...",
  "commerceOnboarding.saBinding.sampleDomain": "yourstore.com",
  "commerceOnboarding.saBinding.oauthNote":
    "Google is still reviewing our app, so its login screen warns that the app isn't verified.",
  "commerceOnboarding.saBinding.ga4.openConsole": "Open Google Analytics",
  "commerceOnboarding.saBinding.ga4.step1":
    "In Google Analytics, open Admin › Property access management.",
  "commerceOnboarding.saBinding.ga4.step2":
    "Click +, choose Add users, paste this e-mail and pick the Viewer role.",
  "commerceOnboarding.saBinding.ga4.step3":
    "Copy the property ID from Admin › Property details and paste it here.",
  "commerceOnboarding.saBinding.ga4.resourceLabel": "Property ID",
  "commerceOnboarding.saBinding.ga4.resourcePlaceholder": "123456789",
  "commerceOnboarding.saBinding.ga4.resourceHint":
    "Digits only, without the 'properties/' prefix.",
  "commerceOnboarding.saBinding.gsc.openConsole": "Open Search Console",
  "commerceOnboarding.saBinding.gsc.step1":
    "In Search Console, open Settings › Users and permissions.",
  "commerceOnboarding.saBinding.gsc.step2":
    "Click Add user, paste this e-mail and choose the Full permission.",
  "commerceOnboarding.saBinding.gsc.step3":
    "Copy the property address exactly as the picker shows it and paste it here.",
  "commerceOnboarding.saBinding.gsc.resourceLabel": "Site or property",
  "commerceOnboarding.saBinding.gsc.resourcePlaceholder": "sc-domain:{host}",
  "commerceOnboarding.saBinding.gsc.resourceHint":
    "Domain property, or the full URL prefix (https://www.{host}/).",
  "commerceOnboarding.saBinding.remediation.noAccess.title":
    "We still can't reach this resource in {label}.",
  "commerceOnboarding.saBinding.remediation.noAccess.ga4.1":
    "Check that {email} is listed under Admin › Property access management with the Viewer role.",
  "commerceOnboarding.saBinding.remediation.noAccess.ga4.2":
    "Check the property ID: digits only, without the 'properties/' prefix.",
  "commerceOnboarding.saBinding.remediation.noAccess.ga4.3":
    "Google can take a few seconds to apply the access. Try again.",
  "commerceOnboarding.saBinding.remediation.noAccess.gsc.1":
    "Check that {email} is listed under Settings › Users and permissions.",
  "commerceOnboarding.saBinding.remediation.noAccess.gsc.2":
    "The permission has to be Full or Restricted. 'Unverified' doesn't work.",
  "commerceOnboarding.saBinding.remediation.noAccess.gsc.3":
    "Check that the address matches exactly what Search Console shows.",
  "commerceOnboarding.saBinding.remediation.noWebStream.title":
    "This GA4 property has no web data stream (site) configured.",
  "commerceOnboarding.saBinding.remediation.noWebStream.1":
    "In GA4, go to Admin › Data streams.",
  "commerceOnboarding.saBinding.remediation.noWebStream.2":
    "Click Add stream › Web.",
  "commerceOnboarding.saBinding.remediation.noWebStream.3":
    "Enter your store's site URL and save the stream.",
  "commerceOnboarding.saBinding.remediation.noWebStream.4":
    "Come back and try again. App-only properties need a manual link, so talk to support.",
  "commerceOnboarding.saBinding.remediation.noMatch.title":
    "That resource doesn't match this store's domain.",
  "commerceOnboarding.saBinding.remediation.noMatch.ga4.1":
    "Check the property ID. It probably belongs to another site.",
  "commerceOnboarding.saBinding.remediation.noMatch.ga4.2":
    "In GA4 the measured site shows under Admin › Data streams › your web stream › stream URL.",
  "commerceOnboarding.saBinding.remediation.noMatch.gsc.1":
    "Check that you picked the Search Console property for this store.",
  "commerceOnboarding.saBinding.remediation.noMatch.gsc.2":
    "The address has to cover the same domain as the diagnostic.",
  "commerceOnboarding.saBinding.remediation.alreadyBound.title":
    "This resource is already linked to another store.",
  "commerceOnboarding.saBinding.remediation.alreadyBound.1":
    "If it really belongs to this store, talk to support for a manual review.",
  "commerceOnboarding.saBinding.remediation.alreadyBound.2":
    "If you typed the wrong id, check it and try again.",
  "commerceOnboarding.saBinding.remediation.unknown.title":
    "We couldn't verify access to this resource.",
  "commerceOnboarding.saBinding.remediation.unknown.1":
    "Go back over the steps above and try again.",
  "commerceOnboarding.saBinding.remediation.unknown.2":
    "If it keeps failing, talk to support.",
  "commerceOnboarding.vtexConfigForm.accountNameLabel": "Account name",
  "commerceOnboarding.vtexConfigForm.accountNamePlaceholder":
    "Your VTEX account name",
  "commerceOnboarding.vtexConfigForm.appKeyLabel": "App Key (optional)",
  "commerceOnboarding.vtexConfigForm.appKeyPlaceholder": "VTEX App Key",
  "commerceOnboarding.vtexConfigForm.appTokenLabel": "App Token (optional)",
  "commerceOnboarding.vtexConfigForm.appTokenPlaceholder": "VTEX App Token",
  "commerceOnboarding.vtexConfigForm.cancelButton": "Cancel",
  "commerceOnboarding.vtexConfigForm.saveButton": "Save",
  "commerceOnboarding.vtexConfigForm.savingButton": "Saving...",
  "commerceOnboarding.vtexConfigForm.savingError":
    "Couldn't save the configuration",
  "commerceOnboarding.shopifyConfigForm.storeDomainLabel": "Store domain",
  "commerceOnboarding.shopifyConfigForm.storeDomainPlaceholder":
    "my-store.myshopify.com",
  "commerceOnboarding.shopifyConfigForm.storeDomainRequired":
    "Enter the store domain",
  "commerceOnboarding.shopifyConfigForm.accessTokenLabel":
    "Admin API access token",
  "commerceOnboarding.shopifyConfigForm.accessTokenRequired":
    "Enter the Admin API access token",
  "commerceOnboarding.shopifyConfigForm.accessTokenPlaceholder": "shpat_...",
  "commerceOnboarding.shopifyConfigForm.apiVersionLabel":
    "API version (optional)",
  "commerceOnboarding.shopifyConfigForm.apiVersionPlaceholder": "2026-07",
  "commerceOnboarding.shopifyConfigForm.cancelButton": "Cancel",
  "commerceOnboarding.shopifyConfigForm.saveButton": "Save",
  "commerceOnboarding.shopifyConfigForm.savingButton": "Saving...",
  "commerceOnboarding.shopifyConfigForm.savingError":
    "Couldn't save the configuration",
  "commerceOnboarding.googleSearchConsoleConfigForm.loadingSites":
    "Loading sites...",
  "commerceOnboarding.googleSearchConsoleConfigForm.loadSitesError":
    "Couldn't load Google Search Console sites.",
  "commerceOnboarding.googleSearchConsoleConfigForm.noSitesFound":
    "No verified site found. Verify a site in Google Search Console.",
  "commerceOnboarding.googleSearchConsoleConfigForm.siteAriaLabel":
    "Verified site",
  "commerceOnboarding.googleSearchConsoleConfigForm.siteRequired":
    "Select a site",
  "commerceOnboarding.googleSearchConsoleConfigForm.savingError":
    "Couldn't save the configuration",
  "commerceOnboarding.googleSearchConsoleConfigForm.cancelButton": "Cancel",
  "commerceOnboarding.googleSearchConsoleConfigForm.saveButton": "Save",
  "commerceOnboarding.googleSearchConsoleConfigForm.savingButton": "Saving...",
  "commerceOnboarding.selectableList.searchPlaceholder": "Search...",
  "commerceOnboarding.selectableList.searchAriaLabel": "Search {label}",
  "commerceOnboarding.selectableList.noResults": "No results",
} as const;
