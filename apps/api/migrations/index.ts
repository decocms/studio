import { type Migration } from "kysely";
import * as migration001initialschema from "./001-initial-schema.ts";
import * as migration002organizationsettings from "./002-organization-settings.ts";
import * as migration003connectionschemaalign from "./003-connection-schema-align.ts";
import * as migration004removemodelsbinding from "./004-remove-models-binding.ts";
import * as migration005connectionconfiguration from "./005-connection-configuration.ts";
import * as migration006addviewstosettings from "./006-add-views-to-settings.ts";
import * as migration007monitoringlogs from "./007-monitoring-logs.ts";
import * as migration008eventbus from "./008-event-bus.ts";
import * as migration009dropauditlogs from "./009-drop-audit-logs.ts";
import * as migration010gateways from "./010-gateways.ts";
import * as migration011gatewayicon from "./011-gateway-icon.ts";
import * as migration012gatewaytoolselectionmode from "./012-gateway-tool-selection-mode.ts";
import * as migration013monitoringuseragentgateway from "./013-monitoring-user-agent-gateway.ts";
import * as migration014gatewayresourcesprompts from "./014-gateway-resources-prompts.ts";
import * as migration015monitoringproperties from "./015-monitoring-properties.ts";
import * as migration016downstreamtokenclientinfo from "./016-downstream-token-client-info.ts";
import * as migration017downstreamtokenremoveuserid from "./017-downstream-token-remove-userid.ts";
import * as migration018dropgatewaytoolselectionstrategy from "./018-drop-gateway-tool-selection-strategy.ts";
import * as migration019removegatewayisdefault from "./019-remove-gateway-is-default.ts";
import * as migration020enabledplugins from "./020-enabled-plugins.ts";
import * as migration021threads from "./021-threads.ts";
import * as migration022renamegatewaytovirtualmcp from "./022-rename-gateway-to-virtual-mcp.ts";
import * as migration023optimizethreadindexes from "./023-optimize-thread-indexes.ts";
import * as migration024consolidatevirtualmcp from "./024-consolidate-virtual-mcp.ts";
import * as migration025addmonitoringvirtualmcpid from "./025-add-monitoring-virtual-mcp-id.ts";
import * as migration026restrictchildconnectiondelete from "./026-restrict-child-connection-delete.ts";
import * as migration027updatemanagementmcpurl from "./027-update-management-mcp-url.ts";
import * as migration028updatemanagementmcptoself from "./028-update-management-mcp-to-self.ts";
import * as migration029addupdatedbytoconnections from "./029-add-updated-by-to-connections.ts";
import * as migration030membertags from "./030-member-tags.ts";
import * as migration031adddependencymode from "./031-add-dependency-mode.ts";
import * as migration032projects from "./032-projects.ts";
import * as migration033threadstatus from "./033-thread-status.ts";
import * as migration034monitoringdashboards from "./034-monitoring-dashboards.ts";
import * as migration035projectconnections from "./035-project-connections.ts";
import * as migration036updateregistryurl from "./036-update-registry-url.ts";
import * as migration037aiproviderkeyss from "./037-ai-provider-keys.ts";
import * as migration038oauthpkcestatess from "./038-oauth-pkce-states.ts";
import * as migration039automations from "./039-automations.ts";
import * as migration040replacenextrunatwithlastrunat from "./040-replace-next-run-at-with-last-run-at.ts";
import * as migration041aiproviderkeysuniqueconstraint from "./041-ai-provider-keys-unique-constraint.ts";
import * as migration042renamemeshmcptocmsmcp from "./042-rename-mesh-mcp-to-cms-mcp.ts";
import * as migration043renamecmsmcptodecocms from "./043-rename-cms-mcp-to-deco-cms.ts";
import * as migration044dropconnectionstoolscolumn from "./044-drop-connections-tools-column.ts";
import * as migration045threadcontextstartmessage from "./045-thread-context-start-message.ts";
import * as migration046removeobjectstorageplugin from "./046-remove-object-storage-plugin.ts";
import * as migration047addnextrunat from "./047-add-next-run-at.ts";
import * as migration048mergeprojectsagents from "./048-merge-projects-agents.ts";
import * as migration049removeorgadminprojects from "./049-remove-org-admin-projects.ts";
import * as migration050durableagentruns from "./050-durable-agent-runs.ts";
import * as migration051orgsso from "./051-org-sso.ts";
import * as migration052threadagentids from "./052-thread-agent-ids.ts";
import * as migration053registryconfig from "./053-registry-config.ts";
import * as migration054connectionslug from "./054-connection-slug.ts";
import * as migration055spaces from "./055-spaces.ts";
import * as migration056automationprojectscope from "./056-automation-project-scope.ts";
import * as migration057threadvirtualmcpid from "./057-thread-virtual-mcp-id.ts";
import * as migration058triggercallbacktokens from "./058-trigger-callback-tokens.ts";
import * as migration059kv from "./059-kv.ts";
import * as migration060memberindex from "./060-member-index.ts";
import * as migration061downstreamtokenconnectionindex from "./061-downstream-token-connection-index.ts";
import * as migration062privateregistry from "./062-private-registry.ts";
import * as migration063eventsubscriptionsenabledboolean from "./063-event-subscriptions-enabled-boolean.ts";
import * as migration064brandcontext from "./064-brand-context.ts";
import * as migration065organizationdomains from "./065-organization-domains.ts";
import * as migration066brandcontextstructured from "./066-brand-context-structured.ts";
import * as migration067threadsmetadata from "./067-threads-metadata.ts";
import * as migration068threadsbranch from "./068-threads-branch.ts";
import * as migration069sandboxrunnerstate from "./069-sandbox-runner-state.ts";
import * as migration070modelcategories from "./070-model-categories.ts";
import * as migration071defaulthomeagents from "./071-default-home-agents.ts";
import * as migration072aiproviderkeypresetid from "./072-ai-provider-key-preset-id.ts";
import * as migration073backfillbasicusageroles from "./073-backfill-basic-usage-roles.ts";
import * as migration074sandboxrunnerstatehandlenonunique from "./074-sandbox-runner-state-handle-nonunique.ts";
import * as migration075threadinflightasyncjobs from "./075-thread-inflight-async-jobs.ts";
import * as migration076automationsdropagentjson from "./076-automations-drop-agent-json.ts";
import * as migration077tieronlymodelselection from "./077-tier-only-model-selection.ts";
import * as migration078automationtoolcallkind from "./078-automation-tool-call-kind.ts";
import * as migration079striplegacyfreestylevmmapentries from "./079-strip-legacy-freestyle-vm-map-entries.ts";
import * as migration080asyncresearchjobs from "./080-async-research-jobs.ts";
import * as migration081asyncresearchjobsresultcontent from "./081-async-research-jobs-result-content.ts";
import * as migration082secrets from "./082-secrets.ts";
import * as migration083threadrunlocally from "./083-thread-run-locally.ts";
import * as migration084drophostsandboxrows from "./084-drop-host-sandbox-rows.ts";
import * as migration085renamerunnerkindd from "./085-rename-runner-kind.ts";
import * as migration086threadpinsandvmmaprekey from "./086-thread-pins-and-vm-map-rekey.ts";
import * as migration087fixvmmaprekey from "./087-fix-vm-map-rekey.ts";
import * as migration088purgecliactivatekeys from "./088-purge-cli-activate-keys.ts";
import * as migration089renameremoteusertodesktop from "./089-rename-remote-user-to-desktop.ts";
import * as migration090automationwebhooktriggers from "./090-automation-webhook-triggers.ts";
import * as migration091organizationdomainsallowmulti from "./091-organization-domains-allow-multi.ts";
import * as migration092sandboxnaminguniformization from "./092-sandbox-naming-uniformization.ts";
import * as migration093backfillglobalsearchbasicusage from "./093-backfill-global-search-basic-usage.ts";
import * as migration094orgfileconfigs from "./094-org-file-configs.ts";
import * as migration095removeautomationtoolcallkind from "./095-remove-automation-tool-call-kind.ts";
import * as migration096orgfileconfigspublicurlbase from "./096-org-file-configs-public-url-base.ts";
import * as migration097droplocaldockersandboxstate from "./097-drop-local-docker-sandbox-state.ts";
import * as migration098threadmessageparts from "./098-thread-message-parts.ts";
import * as migration099runfence from "./099-run-fence.ts";
import * as migration100linktransport from "./100-link-transport.ts";
import * as migration101cancelrequestedat from "./101-cancel-requested-at.ts";
import * as migration102observationalagent from "./102-observational-agent.ts";
import * as migration103revertobservationalagent from "./103-revert-observational-agent.ts";
import * as migration104agentsandboxproviderkind from "./104-agent-sandbox-provider-kind.ts";
import * as migration105orgfs from "./105-org-fs.ts";
import * as migration106automationtools from "./106-automation-tools.ts";
import * as migration107orgfspublicorg from "./107-org-fs-public-org.ts";
import * as migration108automationmaxagentsteps from "./108-automation-max-agent-steps.ts";
import * as migration109threadmessagepartspermessageseq from "./109-thread-message-parts-per-message-seq.ts";
import * as migration110backfillghstokenexpiry from "./110-backfill-ghs-token-expiry.ts";
import * as migration111orgfsthreadid from "./111-org-fs-thread-id.ts";
import * as migration112orgfileconfigscredentialtype from "./112-org-file-configs-credential-type.ts";
import * as migration113threadfailurereason from "./113-thread-failure-reason.ts";
import * as migration114runackedseq from "./114-run-acked-seq.ts";
import * as migration115threadprojectedseq from "./115-thread-projected-seq.ts";
import * as migration116orgsites from "./116-org-sites.ts";
import * as migration117orgfileconfigssiteslug from "./117-org-file-configs-site-slug.ts";
import * as migration118organizationdomainsmultiverify from "./118-organization-domains-multi-verify.ts";
import * as migration119organizationjoinrequests from "./119-organization-join-requests.ts";
import * as migration120orgfsreadpublic from "./120-org-fs-read-public.ts";
import * as migration121orgfssharepassword from "./121-org-fs-share-password.ts";
import * as migration122splitwebresearchtier from "./122-split-web-research-tier.ts";
import * as migration123connectioncredentialvault from "./123-connection-credential-vault.ts";
import * as migration124dropthreadprojectedseq from "./124-drop-thread-projected-seq.ts";
import * as migration125githubchildsingleparent from "./125-github-child-single-parent.ts";
import * as migration126taskboard from "./126-task-board.ts";
import * as migration127taskboardduedate from "./127-task-board-due-date.ts";
import * as migration128reportsonly from "./128-reports-only.ts";
import * as migration129taskboardassignedby from "./129-task-board-assigned-by.ts";
import * as migration130taskboardthreadid from "./130-task-board-thread-id.ts";
import * as migration131taskboardthreadlinkcascade from "./131-task-board-thread-link-cascade.ts";
import * as migration132taskboarditemprs from "./132-task-board-item-prs.ts";
import * as migration133dedupeduplicatemembers from "./133-dedupe-duplicate-members.ts";
import * as migration134droptaskboardenabled from "./134-drop-task-board-enabled.ts";
import * as migration135taskboarditemfkcascade from "./135-task-board-item-fk-cascade.ts";
import * as migration136taskboardimportidempotency from "./136-task-board-import-idempotency.ts";
import * as migration137agentsandboxrunnerstate from "./137-agent-sandbox-runner-state.ts";
import * as migration138agentsandboxsessions from "./138-agent-sandbox-sessions.ts";
import * as migration139organizationbilling from "./139-organization-billing.ts";
import * as migration140seatchangelog from "./140-seat-change-log.ts";
import * as migration141benefitssyncpending from "./141-benefits-sync-pending.ts";
import * as migration142stripeeventwatermark from "./142-stripe-event-watermark.ts";
import * as migration143armedreporturl from "./143-armed-report-url.ts";
import * as migration144benefitspendingindex from "./144-benefits-pending-index.ts";
import * as migration145usermodelpreferences from "./145-user-model-preferences.ts";
import * as migration146organizationmainagent from "./146-organization-main-agent.ts";
import * as migration147dropagentsandboxtables from "./147-drop-agent-sandbox-tables.ts";
import * as migration148orgflags from "./148-org-flags.ts";
import * as migration149taskboarditemsortorder from "./149-task-board-item-sort-order.ts";
import * as migration150taskboardactivity from "./150-task-board-activity.ts";
import * as migration151taskboardtags from "./151-task-board-tags.ts";
import * as migration152repairconnectionslug from "./152-repair-connection-slug.ts";
import * as migration153taskboardlatestassistantpartindex from "./153-task-board-latest-assistant-part-index.ts";
import * as migration154taskboardqaactivity from "./154-task-board-qa-activity.ts";
import * as migration155taskboardreviewclaims from "./155-task-board-review-claims.ts";
import * as migration156taskboardconflictactivity from "./156-task-board-conflict-activity.ts";
import * as migration157dropseatbilling from "./157-drop-seat-billing.ts";
import * as migration158dropgithubchildsingleparent from "./158-drop-github-child-single-parent.ts";
import * as migration159taskboardcomments from "./159-task-board-comments.ts";
import * as migration160taskquotabilling from "./160-task-quota-billing.ts";
import * as migration161taskquotaclaimstate from "./161-task-quota-claim-state.ts";
import * as migration162claudesubscriptions from "./162-claude-subscriptions.ts";
import * as migration163taskboarditemdismissed from "./163-task-board-item-dismissed.ts";
import * as migration164perorgtaskquota from "./164-per-org-task-quota.ts";
import * as migration165taskboardpendingreviewindex from "./165-task-board-pending-review-index.ts";
import * as migration166taskboardlastsweptat from "./166-task-board-last-swept-at.ts";

/**
 * Core migrations for the Studio application.
 *
 * These are managed by Kysely's migrator and run in alphabetical order.
 */
const migrations: Record<string, Migration> = {
  "001-initial-schema": migration001initialschema,
  "002-organization-settings": migration002organizationsettings,
  "003-connection-schema-align": migration003connectionschemaalign,
  "004-remove-models-binding": migration004removemodelsbinding,
  "005-connection-configuration": migration005connectionconfiguration,
  "006-add-views-to-settings": migration006addviewstosettings,
  "007-monitoring-logs": migration007monitoringlogs,
  "008-event-bus": migration008eventbus,
  "009-drop-audit-logs": migration009dropauditlogs,
  "010-gateways": migration010gateways,
  "011-gateway-icon": migration011gatewayicon,
  "012-gateway-tool-selection-mode": migration012gatewaytoolselectionmode,
  "013-monitoring-user-agent-gateway": migration013monitoringuseragentgateway,
  "014-gateway-resources-prompts": migration014gatewayresourcesprompts,
  "015-monitoring-properties": migration015monitoringproperties,
  "016-downstream-token-client-info": migration016downstreamtokenclientinfo,
  "017-downstream-token-remove-userid": migration017downstreamtokenremoveuserid,
  "018-drop-gateway-tool-selection-strategy":
    migration018dropgatewaytoolselectionstrategy,
  "019-remove-gateway-is-default": migration019removegatewayisdefault,
  "020-enabled-plugins": migration020enabledplugins,
  "021-threads": migration021threads,
  "022-rename-gateway-to-virtual-mcp": migration022renamegatewaytovirtualmcp,
  "023-optimize-thread-indexes": migration023optimizethreadindexes,
  "024-consolidate-virtual-mcp": migration024consolidatevirtualmcp,
  "025-add-monitoring-virtual-mcp-id": migration025addmonitoringvirtualmcpid,
  "026-restrict-child-connection-delete":
    migration026restrictchildconnectiondelete,
  "027-update-management-mcp-url": migration027updatemanagementmcpurl,
  "028-update-management-mcp-to-self": migration028updatemanagementmcptoself,
  "029-add-updated-by-to-connections": migration029addupdatedbytoconnections,
  "030-member-tags": migration030membertags,
  "031-add-dependency-mode": migration031adddependencymode,
  "032-projects": migration032projects,
  "033-thread-status": migration033threadstatus,
  "034-monitoring-dashboards": migration034monitoringdashboards,
  "035-project-connections": migration035projectconnections,
  "036-update-registry-url": migration036updateregistryurl,
  "037-ai-provider-keys": migration037aiproviderkeyss,
  "038-oauth-pkce-states": migration038oauthpkcestatess,
  "039-automations": migration039automations,
  "040-replace-next-run-at-with-last-run-at":
    migration040replacenextrunatwithlastrunat,
  "041-ai-provider-keys-unique-constraint":
    migration041aiproviderkeysuniqueconstraint,
  "042-rename-mesh-mcp-to-cms-mcp": migration042renamemeshmcptocmsmcp,
  "043-rename-cms-mcp-to-deco-cms": migration043renamecmsmcptodecocms,
  "044-drop-connections-tools-column": migration044dropconnectionstoolscolumn,
  "045-thread-context-start-message": migration045threadcontextstartmessage,
  "046-remove-object-storage-plugin": migration046removeobjectstorageplugin,
  "047-add-next-run-at": migration047addnextrunat,
  "048-merge-projects-agents": migration048mergeprojectsagents,
  "049-remove-org-admin-projects": migration049removeorgadminprojects,
  "050-durable-agent-runs": migration050durableagentruns,
  "051-org-sso": migration051orgsso,
  "052-thread-agent-ids": migration052threadagentids,
  "053-registry-config": migration053registryconfig,
  "054-connection-slug": migration054connectionslug,
  "055-spaces": migration055spaces,
  "056-automation-project-scope": migration056automationprojectscope,
  "057-thread-virtual-mcp-id": migration057threadvirtualmcpid,
  "058-trigger-callback-tokens": migration058triggercallbacktokens,
  "059-kv": migration059kv,
  "060-member-index": migration060memberindex,
  "061-downstream-token-connection-index":
    migration061downstreamtokenconnectionindex,
  "062-private-registry": migration062privateregistry,
  "063-event-subscriptions-enabled-boolean":
    migration063eventsubscriptionsenabledboolean,
  "064-brand-context": migration064brandcontext,
  "065-organization-domains": migration065organizationdomains,
  "066-brand-context-structured": migration066brandcontextstructured,
  "067-threads-metadata": migration067threadsmetadata,
  "068-threads-branch": migration068threadsbranch,
  "069-sandbox-runner-state": migration069sandboxrunnerstate,
  "070-model-categories": migration070modelcategories,
  "071-default-home-agents": migration071defaulthomeagents,
  "072-ai-provider-key-preset-id": migration072aiproviderkeypresetid,
  "073-backfill-basic-usage-roles": migration073backfillbasicusageroles,
  "074-sandbox-runner-state-handle-nonunique":
    migration074sandboxrunnerstatehandlenonunique,
  "075-thread-inflight-async-jobs": migration075threadinflightasyncjobs,
  "076-automations-drop-agent-json": migration076automationsdropagentjson,
  "077-tier-only-model-selection": migration077tieronlymodelselection,
  "078-automation-tool-call-kind": migration078automationtoolcallkind,
  "079-strip-legacy-freestyle-vm-map-entries":
    migration079striplegacyfreestylevmmapentries,
  "080-async-research-jobs": migration080asyncresearchjobs,
  "081-async-research-jobs-result-content":
    migration081asyncresearchjobsresultcontent,
  "082-secrets": migration082secrets,
  "083-thread-run-locally": migration083threadrunlocally,
  "084-drop-host-sandbox-rows": migration084drophostsandboxrows,
  "085-rename-runner-kind": migration085renamerunnerkindd,
  "086-thread-pins-and-vm-map-rekey": migration086threadpinsandvmmaprekey,
  "087-fix-vm-map-rekey": migration087fixvmmaprekey,
  "088-purge-cli-activate-keys": migration088purgecliactivatekeys,
  "089-rename-remote-user-to-desktop": migration089renameremoteusertodesktop,
  "090-automation-webhook-triggers": migration090automationwebhooktriggers,
  "091-organization-domains-allow-multi":
    migration091organizationdomainsallowmulti,
  "092-sandbox-naming-uniformization": migration092sandboxnaminguniformization,
  "093-backfill-global-search-basic-usage":
    migration093backfillglobalsearchbasicusage,
  "094-org-file-configs": migration094orgfileconfigs,
  "095-remove-automation-tool-call-kind":
    migration095removeautomationtoolcallkind,
  "096-org-file-configs-public-url-base":
    migration096orgfileconfigspublicurlbase,
  "097-drop-local-docker-sandbox-state":
    migration097droplocaldockersandboxstate,
  "098-thread-message-parts": migration098threadmessageparts,
  "099-run-fence": migration099runfence,
  "100-link-transport": migration100linktransport,
  "101-cancel-requested-at": migration101cancelrequestedat,
  "102-observational-agent": migration102observationalagent,
  "103-revert-observational-agent": migration103revertobservationalagent,
  "104-agent-sandbox-provider-kind": migration104agentsandboxproviderkind,
  "105-org-fs": migration105orgfs,
  "106-automation-tools": migration106automationtools,
  "107-org-fs-public-org": migration107orgfspublicorg,
  "108-automation-max-agent-steps": migration108automationmaxagentsteps,
  "109-thread-message-parts-per-message-seq":
    migration109threadmessagepartspermessageseq,
  "110-backfill-ghs-token-expiry": migration110backfillghstokenexpiry,
  "111-org-fs-thread-id": migration111orgfsthreadid,
  "112-org-file-configs-credential-type":
    migration112orgfileconfigscredentialtype,
  "113-thread-failure-reason": migration113threadfailurereason,
  "114-run-acked-seq": migration114runackedseq,
  "115-thread-projected-seq": migration115threadprojectedseq,
  "116-org-sites": migration116orgsites,
  "117-org-file-configs-site-slug": migration117orgfileconfigssiteslug,
  "118-organization-domains-multi-verify":
    migration118organizationdomainsmultiverify,
  "119-organization-join-requests": migration119organizationjoinrequests,
  "120-org-fs-read-public": migration120orgfsreadpublic,
  "121-org-fs-share-password": migration121orgfssharepassword,
  "122-split-web-research-tier": migration122splitwebresearchtier,
  "123-connection-credential-vault": migration123connectioncredentialvault,
  "124-drop-thread-projected-seq": migration124dropthreadprojectedseq,
  "125-github-child-single-parent": migration125githubchildsingleparent,
  "126-task-board": migration126taskboard,
  "127-task-board-due-date": migration127taskboardduedate,
  "128-reports-only": migration128reportsonly,
  "129-task-board-assigned-by": migration129taskboardassignedby,
  "130-task-board-thread-id": migration130taskboardthreadid,
  "131-task-board-thread-link-cascade": migration131taskboardthreadlinkcascade,
  "132-task-board-item-prs": migration132taskboarditemprs,
  "133-dedupe-duplicate-members": migration133dedupeduplicatemembers,
  "134-drop-task-board-enabled": migration134droptaskboardenabled,
  "135-task-board-item-fk-cascade": migration135taskboarditemfkcascade,
  "136-task-board-import-idempotency": migration136taskboardimportidempotency,
  "137-agent-sandbox-runner-state": migration137agentsandboxrunnerstate,
  "138-agent-sandbox-sessions": migration138agentsandboxsessions,
  "139-organization-billing": migration139organizationbilling,
  "140-seat-change-log": migration140seatchangelog,
  "141-benefits-sync-pending": migration141benefitssyncpending,
  "142-stripe-event-watermark": migration142stripeeventwatermark,
  "143-armed-report-url": migration143armedreporturl,
  "144-benefits-pending-index": migration144benefitspendingindex,
  "145-user-model-preferences": migration145usermodelpreferences,
  "146-organization-main-agent": migration146organizationmainagent,
  "147-drop-agent-sandbox-tables": migration147dropagentsandboxtables,
  "148-org-flags": migration148orgflags,
  "149-task-board-item-sort-order": migration149taskboarditemsortorder,
  "150-task-board-activity": migration150taskboardactivity,
  "151-task-board-tags": migration151taskboardtags,
  "152-repair-connection-slug": migration152repairconnectionslug,
  "153-task-board-latest-assistant-part-index":
    migration153taskboardlatestassistantpartindex,
  "154-task-board-qa-activity": migration154taskboardqaactivity,
  "155-task-board-review-claims": migration155taskboardreviewclaims,
  "156-task-board-conflict-activity": migration156taskboardconflictactivity,
  "157-drop-seat-billing": migration157dropseatbilling,
  "158-drop-github-child-single-parent":
    migration158dropgithubchildsingleparent,
  "159-task-board-comments": migration159taskboardcomments,
  "160-task-quota-billing": migration160taskquotabilling,
  "161-task-quota-claim-state": migration161taskquotaclaimstate,
  "162-claude-subscriptions": migration162claudesubscriptions,
  "163-task-board-item-dismissed": migration163taskboarditemdismissed,
  "164-per-org-task-quota": migration164perorgtaskquota,
  "165-task-board-pending-review-index":
    migration165taskboardpendingreviewindex,
  "166-task-board-last-swept-at": migration166taskboardlastsweptat,
};

export default migrations;
