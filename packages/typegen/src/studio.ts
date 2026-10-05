#!/usr/bin/env node

import process from "node:process";
import { runStudioCli } from "@decocms/studio-cli";

// The same `decocms` Studio commands the server package ships, so an agent
// inside a Studio sandbox (which installs this package) uses one vocabulary.
process.exit(await runStudioCli(process.argv.slice(2)));
