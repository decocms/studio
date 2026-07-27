import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { Providers } from "@/providers/providers";
import { router } from "@/router";
import "../index.css";
import { migrateLegacyStorageKeys } from "@/lib/legacy-storage";
import { initPwaInstallCapture } from "@/lib/pwa-install";

migrateLegacyStorageKeys(window.localStorage);

// The native build has its own HTML entry, but this literal import keeps that
// entry reachable to whole-repository module graph tooling.
if (import.meta.env.VITE_TAURI_APP === "1") {
  void import("./index.native");
}

initPwaInstallCapture();

const rootElement = document.getElementById("root")!;

createRoot(rootElement).render(
  <StrictMode>
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  </StrictMode>,
);
