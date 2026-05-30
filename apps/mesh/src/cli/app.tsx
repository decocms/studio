import { Box } from "ink";
import { useSyncExternalStore } from "react";
import { Header } from "./header";
import { RequestLog } from "./request-log";
import { getCliState, subscribeCliState } from "./cli-store";

export function App({ home }: { home: string }) {
  const state = useSyncExternalStore(subscribeCliState, getCliState);

  return (
    <Box flexDirection="column">
      <Header
        services={state.services}
        migrationsStatus={state.migrationsStatus}
        home={home}
        serverUrl={state.serverUrl}
      />
      <RequestLog logs={state.logs} />
    </Box>
  );
}
