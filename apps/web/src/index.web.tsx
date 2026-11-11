import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { Providers } from "@/providers/providers";
import { router } from "@/router";
import "../index.css";
import { migrateLegacyStorageKeys } from "@/lib/legacy-storage";
import { captureLegacyAdminArrival } from "@/lib/legacy-admin-arrival";

migrateLegacyStorageKeys(window.localStorage);
captureLegacyAdminArrival(window.location.search);

const rootElement = document.getElementById("root")!;

createRoot(rootElement).render(
  <StrictMode>
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  </StrictMode>,
);
