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

/**
 * Core migrations for the Mesh application.
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
};

export default migrations;
