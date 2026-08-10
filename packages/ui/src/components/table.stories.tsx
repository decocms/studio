import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "./table.tsx";

const meta = {
  title: "Components/Table",
  component: Table,
  parameters: { layout: "padded" },
} satisfies Meta<typeof Table>;

export default meta;
type Story = StoryObj<typeof meta>;

const members = [
  { name: "Ana Souza", email: "ana@acme.com", role: "Owner", status: "Active" },
  {
    name: "Bruno Lima",
    email: "bruno@acme.com",
    role: "Admin",
    status: "Active",
  },
  {
    name: "Carla Mendes",
    email: "carla@acme.com",
    role: "Member",
    status: "Invited",
  },
  {
    name: "Diego Santos",
    email: "diego@acme.com",
    role: "Member",
    status: "Active",
  },
  {
    name: "Elisa Rocha",
    email: "elisa@acme.com",
    role: "Viewer",
    status: "Suspended",
  },
];

export const Default: Story = {
  render: () => (
    <div className="w-[640px]">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Role</TableHead>
            <TableHead className="text-right">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((member) => (
            <TableRow key={member.email}>
              <TableCell className="font-medium">{member.name}</TableCell>
              <TableCell className="text-muted-foreground">
                {member.email}
              </TableCell>
              <TableCell>{member.role}</TableCell>
              <TableCell className="text-right">{member.status}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  ),
};

export const WithCaption: Story = {
  render: () => (
    <div className="w-[640px]">
      <Table>
        <TableCaption>Members of the Acme Inc organization.</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Role</TableHead>
            <TableHead className="text-right">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.slice(0, 3).map((member) => (
            <TableRow key={member.email}>
              <TableCell className="font-medium">{member.name}</TableCell>
              <TableCell>{member.role}</TableCell>
              <TableCell className="text-right">{member.status}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  ),
};

export const WithFooter: Story = {
  render: () => (
    <div className="w-[640px]">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Connection</TableHead>
            <TableHead>Tool calls</TableHead>
            <TableHead className="text-right">Cost</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell className="font-medium">Slack</TableCell>
            <TableCell>1,204</TableCell>
            <TableCell className="text-right">$12.04</TableCell>
          </TableRow>
          <TableRow>
            <TableCell className="font-medium">GitHub</TableCell>
            <TableCell>876</TableCell>
            <TableCell className="text-right">$8.76</TableCell>
          </TableRow>
          <TableRow>
            <TableCell className="font-medium">Postgres</TableCell>
            <TableCell>2,310</TableCell>
            <TableCell className="text-right">$23.10</TableCell>
          </TableRow>
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell colSpan={2}>Total</TableCell>
            <TableCell className="text-right">$43.90</TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  ),
};

export const SelectedRow: Story = {
  render: () => (
    <div className="w-[640px]">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Role</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell className="font-medium">Ana Souza</TableCell>
            <TableCell>Owner</TableCell>
          </TableRow>
          <TableRow data-state="selected">
            <TableCell className="font-medium">Bruno Lima</TableCell>
            <TableCell>Admin</TableCell>
          </TableRow>
          <TableRow>
            <TableCell className="font-medium">Carla Mendes</TableCell>
            <TableCell>Member</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  ),
};
