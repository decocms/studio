// Step 1: register happy-dom globals BEFORE any testing-library code loads.
// This file is listed first in bunfig.toml [test] preload so DOM APIs are
// available when test-setup-rtl.ts imports @testing-library/react.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost:3000" });
