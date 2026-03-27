declare module "chrome-har" {
  interface HarOptions {
    includeResourcesFromDiskCache?: boolean;
    includeTextFromResponseBody?: boolean;
  }

  interface HarResult {
    log: {
      entries: Array<{
        startedDateTime: string;
        time: number;
        request: {
          method: string;
          url: string;
          headers: Array<{ name: string; value: string }>;
        };
        response: {
          status: number;
          headers: Array<{ name: string; value: string }>;
          content: {
            size: number;
            mimeType: string;
          };
        };
        timings: {
          blocked: number;
          dns: number;
          connect: number;
          ssl: number;
          send: number;
          wait: number;
          receive: number;
        };
      }>;
    };
  }

  export function harFromMessages(
    messages: Array<{ method: string; params: unknown }>,
    options?: HarOptions,
  ): HarResult;
}
