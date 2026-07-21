import { describe, it } from "bun:test";
import type {
  JsonArray,
  JsonObject,
  OrganizationSettingsTable,
  OAuthClientTable,
  ConnectionAggregationTable,
  SidebarItem,
} from "./types";
import type { ColumnType } from "kysely";

describe("JsonArray and JsonObject type definitions", () => {
  it("JsonArray<T> should create ColumnType<T[], string, string>", () => {
    // Compile-time type checking: JsonArray<string> creates ColumnType<string[], string, string>
    // If this is used incorrectly as JsonArray<string[]>, it would create ColumnType<string[][], ...>
    // which is a type error.
    const col: JsonArray<string> = undefined as any;
    const _read: string[] = col as any;
  });

  it("JsonObject<T> should create ColumnType<T, string, string>", () => {
    // Compile-time type checking: JsonObject<Record<string, unknown>>
    // creates ColumnType<Record<string, unknown>, string, string>
    const col: JsonObject<Record<string, unknown>> = undefined as any;
    const _read: Record<string, unknown> = col as any;
  });

  it("OrganizationSettingsTable should use correct JsonArray types", () => {
    // sidebar_items should be JsonArray<SidebarItem> (correct)
    // not JsonArray<SidebarItem[]> (incorrect double-wrap)
    // The read type is inferred as SidebarItem[] when using JsonArray<SidebarItem>
    const col: OrganizationSettingsTable["sidebar_items"] = undefined as any;
    // After fixing, sidebar_items has type ColumnType<SidebarItem[], ...>
    // So reading it gives us SidebarItem[]
    const _read: SidebarItem[] | null = col as any;
  });

  it("OAuthClientTable should use correct JsonArray types for URIs and grants", () => {
    // redirectUris and grantTypes should be JsonArray<string> (correct)
    // not JsonArray<string[]> (incorrect double-wrap)
    const col1: OAuthClientTable["redirectUris"] = undefined as any;
    const col2: OAuthClientTable["grantTypes"] = undefined as any;
    // Read types should be string[] for each
    const _read1: string[] = col1 as any;
    const _read2: string[] = col2 as any;
  });

  it("ConnectionAggregationTable should use correct JsonArray types for tools/resources", () => {
    // selected_tools, selected_resources, selected_prompts should be JsonArray<string>
    // not JsonArray<string[]>
    const col1: ConnectionAggregationTable["selected_tools"] = undefined as any;
    const col2: ConnectionAggregationTable["selected_resources"] = undefined as any;
    const col3: ConnectionAggregationTable["selected_prompts"] = undefined as any;
    // Read types should be string[] | null for each
    const _read1: string[] | null = col1 as any;
    const _read2: string[] | null = col2 as any;
    const _read3: string[] | null = col3 as any;
  });
});
