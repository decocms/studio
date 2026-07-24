/**
 * Service management commands: up, down, status.
 *
 * Replaces scripts/dev-services-cli.ts with a proper CLI subcommand.
 * Plain console output — no Ink UI needed for these one-shot commands.
 */
function externalUrlOrNull(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

export interface ServicesOptions {
  subcommand: string;
  home: string;
}

export async function servicesCommand(options: ServicesOptions): Promise<void> {
  const { subcommand, home } = options;

  const { ensureServices, stopServices, getStatus, printTable } = await import(
    "../../services/ensure-services"
  );

  switch (subcommand) {
    case "up": {
      await ensureServices({
        home,
        externalDatabaseUrl: externalUrlOrNull(process.env.DATABASE_URL),
        externalNatsUrl: externalUrlOrNull(process.env.NATS_URL),
      });
      break;
    }
    case "down": {
      await stopServices(home);
      break;
    }
    case "status": {
      const services = await getStatus(home);
      printTable(services);
      break;
    }
    default: {
      console.error(
        `Unknown services subcommand: ${subcommand}\nUsage: deco services <up|down|status>`,
      );
      process.exit(1);
    }
  }
}
