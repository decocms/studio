#!/usr/bin/env node

import { exitAfterFlush, runStudioCli } from "./index";

await exitAfterFlush(await runStudioCli(process.argv.slice(2)));
