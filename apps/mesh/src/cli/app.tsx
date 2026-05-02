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
import { skipTrack, toggleVibe } from "./vibe/vibe-player";

const HEADER_HEIGHT = 15;
const HEADER_HEIGHT_VIBE = 19;

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
    if ((_input === "n" || _input === "N") && state.vibe) {
      skipTrack();
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
        autostartProject={state.autostartProject}
      />

      {state.viewMode === "config" ? (
        state.env ? (
          <ConfigView env={state.env} />
        ) : (
          <Text dimColor>Loading configuration...</Text>
        )
      ) : (
        <RequestLog
          logs={state.logs}
          headerHeight={state.vibe ? HEADER_HEIGHT_VIBE : HEADER_HEIGHT}
        />
      )}
    </Box>
  );
}
