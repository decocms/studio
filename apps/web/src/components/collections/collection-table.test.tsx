import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import {
  CollectionTable,
  type CollectionTableColumn,
} from "./collection-table";

interface Row {
  id: string;
  name: string;
  status: string;
}

const rows: Row[] = [{ id: "row-1", name: "Alpha", status: "Ready" }];
const columns: CollectionTableColumn<Row>[] = [
  {
    id: "name",
    header: "Name",
    accessor: (row) => row.name,
    sortable: true,
  },
  { id: "status", header: "Status", accessor: (row) => row.status },
];

describe("CollectionTable", () => {
  it("exposes sort state through a keyboard-operable header control", () => {
    const onSort = mock();
    const { getByRole } = render(
      <CollectionTable
        columns={columns}
        data={rows}
        getRowId={(row) => row.id}
        sortKey="name"
        sortDirection="asc"
        onSort={onSort}
      />,
    );

    expect(getByRole("columnheader", { name: "Name" })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    fireEvent.click(getByRole("button", { name: "Name" }));
    expect(onSort).toHaveBeenCalledWith("name");
  });

  it("uses a named primary action instead of a mouse-only clickable row", () => {
    const onRowClick = mock();
    const { getByRole } = render(
      <CollectionTable
        columns={columns}
        data={rows}
        getRowId={(row) => row.id}
        getRowActionLabel={(row) => `Open ${row.name}`}
        onRowClick={onRowClick}
      />,
    );

    fireEvent.click(getByRole("button", { name: "Open Alpha" }));
    expect(onRowClick).toHaveBeenCalledWith(rows[0]);
  });
});
