// NOTE: Uses forward-slash concatenation instead of path.join()
// because DuckDB read_parquet() requires forward slashes in glob patterns,
// and S3 URLs (s3://bucket/path) would be mangled by path.join().

/**
 * Default base path for Parquet monitoring files.
 * Override via MONITORING_PARQUET_PATH environment variable.
 */
export const DEFAULT_PARQUET_BASE_PATH = "./data/monitoring";

/**
 * Get the time-partitioned directory path for a given timestamp.
 * Format: basePath/YYYY/MM/DD/HH
 */
export function getPartitionDir(basePath: string, date: Date): string {
  const year = date.getUTCFullYear().toString();
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  const hour = date.getUTCHours().toString().padStart(2, "0");
  return `${basePath}/${year}/${month}/${day}/${hour}`;
}

/**
 * Get the full file path for a batch Parquet file.
 * Format: basePath/YYYY/MM/DD/HH/batch-NNNNNN.parquet
 */
export function getBatchFilePath(
  basePath: string,
  date: Date,
  counter: number,
): string {
  const dir = getPartitionDir(basePath, date);
  const paddedCounter = counter.toString().padStart(6, "0");
  return `${dir}/batch-${paddedCounter}.parquet`;
}

/**
 * Get a glob pattern for querying Parquet files.
 * Supports narrowing by year/month/day/hour for efficient scans.
 */
export function getGlobPattern(
  basePath: string,
  range?: {
    year?: string;
    month?: string;
    day?: string;
    hour?: string;
  },
): string {
  if (!range) {
    return `${basePath}/**/*.parquet`;
  }

  let path = basePath;
  if (range.year) path = `${path}/${range.year}`;
  else return `${path}/**/*.parquet`;

  if (range.month) path = `${path}/${range.month}`;
  else return `${path}/**/*.parquet`;

  if (range.day) path = `${path}/${range.day}`;
  else return `${path}/**/*.parquet`;

  if (range.hour) path = `${path}/${range.hour}`;
  else return `${path}/**/*.parquet`;

  return `${path}/*.parquet`;
}

/**
 * Extract date range from filters to narrow Parquet glob scans.
 * Returns a range object that narrows the glob to only relevant directories.
 */
export function dateRangeToGlobRange(
  startDate?: Date,
  endDate?: Date,
): { year?: string; month?: string; day?: string } | undefined {
  if (!startDate || !endDate) return undefined;

  const startYear = startDate.getUTCFullYear().toString();
  const endYear = endDate.getUTCFullYear().toString();
  if (startYear !== endYear) return undefined; // Multi-year range: scan all

  const startMonth = (startDate.getUTCMonth() + 1).toString().padStart(2, "0");
  const endMonth = (endDate.getUTCMonth() + 1).toString().padStart(2, "0");
  if (startMonth !== endMonth) return { year: startYear };

  const startDay = startDate.getUTCDate().toString().padStart(2, "0");
  const endDay = endDate.getUTCDate().toString().padStart(2, "0");
  if (startDay !== endDay) return { year: startYear, month: startMonth };

  return { year: startYear, month: startMonth, day: startDay };
}
