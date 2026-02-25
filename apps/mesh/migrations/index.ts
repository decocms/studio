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
import * as migration035diagnosticsessions from "./035-diagnostic-sessions.ts";

/**
 * Core migrations for the Mesh application.
 *
 * These are managed by Kysely's migrator and run in alphabetical order.
 * Plugin migrations are handled separately by the plugin migration system
 * (see src/database/migrate.ts) to avoid ordering conflicts.
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
  "035-diagnostic-sessions": migration035diagnosticsessions,
};

export default migrations;
