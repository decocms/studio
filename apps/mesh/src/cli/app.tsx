import { Box, useApp, useInput } from "ink";
import { useSyncExternalStore } from "react";
import { ConfigView } from "./config-view";
import { Header } from "./header";
import { RequestLog } from "./request-log";
import { getCliState, subscribeCliState, toggleViewMode } from "./cli-store";

const HEADER_HEIGHT = 8;

export function App({ home }: { home: string }) {
  const { exit } = useApp();
  const state = useSyncExternalStore(subscribeCliState, getCliState);

  useInput((_input, key) => {
    if (key.meta && _input === "k") {
      toggleViewMode();
    }
    if (key.meta && _input === "l") {
      // Exit Ink for full log mode — handled by the CLI entry point
      exit();
    }
  });

  return (
    <Box flexDirection="column">
      <Header
        services={state.services}
        migrationsStatus={state.migrationsStatus}
        home={home}
        serverUrl={state.serverUrl}
      />

      {state.viewMode === "config" && state.env ? (
        <ConfigView env={state.env} />
      ) : (
        <RequestLog logs={state.logs} headerHeight={HEADER_HEIGHT} />
      )}
    </Box>
  );
}
