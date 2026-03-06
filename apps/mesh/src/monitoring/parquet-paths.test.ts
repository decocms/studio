import { describe, it, expect } from "bun:test";
import {
  getPartitionDir,
  getBatchFilePath,
  getGlobPattern,
} from "./parquet-paths";

describe("parquet-paths", () => {
  describe("getPartitionDir", () => {
    it("returns time-partitioned directory path", () => {
      const date = new Date("2026-03-06T14:30:00Z");
      const basePath = "./data/monitoring";
      const result = getPartitionDir(basePath, date);
      expect(result).toBe("./data/monitoring/2026/03/06/14");
    });

    it("zero-pads month, day, and hour", () => {
      const date = new Date("2026-01-02T03:00:00Z");
      const result = getPartitionDir("./data/monitoring", date);
      expect(result).toBe("./data/monitoring/2026/01/02/03");
    });
  });

  describe("getBatchFilePath", () => {
    it("returns batch file path with counter", () => {
      const date = new Date("2026-03-06T14:30:00Z");
      const result = getBatchFilePath("./data/monitoring", date, 5);
      expect(result).toBe(
        "./data/monitoring/2026/03/06/14/batch-000005.parquet",
      );
    });

    it("zero-pads counter to 6 digits", () => {
      const result = getBatchFilePath(
        "./data/monitoring",
        new Date("2026-01-01T00:00:00Z"),
        42,
      );
      expect(result).toBe(
        "./data/monitoring/2026/01/01/00/batch-000042.parquet",
      );
    });
  });

  describe("getGlobPattern", () => {
    it("returns glob for all parquet files", () => {
      const result = getGlobPattern("./data/monitoring");
      expect(result).toBe("./data/monitoring/**/*.parquet");
    });

    it("returns glob for specific year", () => {
      const result = getGlobPattern("./data/monitoring", { year: "2026" });
      expect(result).toBe("./data/monitoring/2026/**/*.parquet");
    });

    it("returns glob for specific date", () => {
      const result = getGlobPattern("./data/monitoring", {
        year: "2026",
        month: "03",
        day: "06",
      });
      expect(result).toBe("./data/monitoring/2026/03/06/**/*.parquet");
    });

    it("returns glob for specific hour", () => {
      const result = getGlobPattern("./data/monitoring", {
        year: "2026",
        month: "03",
        day: "06",
        hour: "14",
      });
      expect(result).toBe("./data/monitoring/2026/03/06/14/*.parquet");
    });
  });
});
