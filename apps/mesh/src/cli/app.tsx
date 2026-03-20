import { Box, Text, useInput } from "ink";
import { useSyncExternalStore } from "react";
import { ConfigView } from "./config-view";
import { Header } from "./header";
import { RequestLog } from "./request-log";
import { getCliState, subscribeCliState, toggleViewMode } from "./cli-store";

const HEADER_HEIGHT = 13;

export function App({ home }: { home: string }) {
  const state = useSyncExternalStore(subscribeCliState, getCliState);

  useInput((_input) => {
    if (_input === "K") {
      toggleViewMode();
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

      {state.viewMode === "config" ? (
        state.env ? (
          <ConfigView env={state.env} />
        ) : (
          <Text dimColor>Loading configuration...</Text>
        )
      ) : (
        <RequestLog logs={state.logs} headerHeight={HEADER_HEIGHT} />
      )}
    </Box>
  );
}
