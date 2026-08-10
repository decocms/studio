import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { FilterBar, type Filter, type FilterBarUser } from "./filter-bar.tsx";

const teamMembers: FilterBarUser[] = [
  { id: "user-1", name: "Ana Souza" },
  { id: "user-2", name: "Bruno Lima" },
  { id: "user-3", name: "Carla Mendes" },
  { id: "user-4", name: "Diego Ferreira" },
];

const meta = {
  title: "Components/FilterBar",
  component: FilterBar,
  parameters: { layout: "padded" },
  args: {
    filters: [],
    onFiltersChange: () => {},
    availableUsers: teamMembers,
  },
} satisfies Meta<typeof FilterBar>;

export default meta;
type Story = StoryObj<typeof meta>;

function ControlledDemo({ initialFilters }: { initialFilters: Filter[] }) {
  const [filters, setFilters] = useState<Filter[]>(initialFilters);
  return (
    <div className="w-[640px]">
      <FilterBar
        filters={filters}
        onFiltersChange={setFilters}
        availableUsers={teamMembers}
      />
    </div>
  );
}

/** Click "Add filter" to walk the column → operator → value flow. */
export const Default: Story = {
  render: () => <ControlledDemo initialFilters={[]} />,
};

/** A realistic composition: text, owner and date filters. Click a chip to edit it, hover to reveal remove. */
export const WithFilters: Story = {
  render: () => (
    <ControlledDemo
      initialFilters={[
        {
          id: "f-1",
          column: "name",
          operator: "contains",
          value: "support",
        },
        {
          id: "f-2",
          column: "created_by",
          operator: "is",
          value: "user-2",
        },
        {
          id: "f-3",
          column: "updated_at",
          operator: "in_last",
          value: "7d",
        },
      ]}
    />
  ),
};

function initials(name: string) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("");
}

function CustomUserDemo() {
  const [filters, setFilters] = useState<Filter[]>([
    { id: "f-1", column: "created_by", operator: "is", value: "user-1" },
  ]);
  return (
    <div className="w-[640px]">
      <FilterBar
        filters={filters}
        onFiltersChange={setFilters}
        availableUsers={teamMembers}
        renderUserItem={(user) => (
          <span className="flex items-center gap-2">
            <span className="flex size-5 items-center justify-center rounded-full bg-primary text-[10px] font-medium text-primary-foreground">
              {initials(user.name ?? user.id)}
            </span>
            <span className="truncate">{user.name ?? user.id}</span>
          </span>
        )}
      />
    </div>
  );
}

/** `renderUserItem` customizes how users appear in chips and the picker. */
export const CustomUserRendering: Story = {
  render: () => <CustomUserDemo />,
};
