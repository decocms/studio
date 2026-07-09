import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CompanionCardModel } from "../companions-core.ts";

export interface CompanionOrg {
  id: string;
  slug: string;
}

export interface CompanionFormProps {
  card: CompanionCardModel;
  connectionId: string;
  companionClient: Client;
  selfClient: Client;
  org: CompanionOrg;
  contextSiteUrl?: string;
  onDone: () => void;
  onDisconnect?: () => void;
  onIsPendingChange?: (isPending: boolean) => void;
}

export type CompanionFormComponent = React.FC<CompanionFormProps>;
