import { Box, Text, useInput } from "ink";
import { useSyncExternalStore } from "react";
import { ConfigView } from "./config-view";
import { Header } from "./header";
import { RequestLog } from "./request-log";
import {
  getCliState,
  subscribeCliState,
  toggleLogFlow,
  toggleViewMode,
  toggleVibeState,
} from "./cli-store";
import { toggleVibe } from "./vibe/vibe-player";

const HEADER_HEIGHT = 15;

export function App({ home }: { home: string }) {
  const state = useSyncExternalStore(subscribeCliState, getCliState);

  useInput((_input) => {
    if (_input === "k" || _input === "K") {
      toggleViewMode();
    }
    if (_input === "l" || _input === "L") {
      toggleLogFlow();
    }
    if ((_input === "v" || _input === "V") && state.dataDir) {
      toggleVibe(state.dataDir);
      toggleVibeState();
    }
  });

  return (
    <Box flexDirection="column">
      <Header
        services={state.services}
        migrationsStatus={state.migrationsStatus}
        home={home}
        serverUrl={state.serverUrl}
        vibe={state.vibe}
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
