import { createContext, useContext } from "react";

/** Another org the Monitor looks into: `all` or one org's slug; undefined = your own. */
export const MonitorOrgContext = createContext<string | undefined>(undefined);

export const useMonitorOrg = () => useContext(MonitorOrgContext);
