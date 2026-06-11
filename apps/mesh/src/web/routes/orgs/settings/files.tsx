import { OrgFsFilesPage } from "@/web/views/settings/org-files";

// No capability gate: the org filesystem is member-accessible by design
// (ORG_FS_READ/WRITE are basic-usage — see api/routes/org-fs.ts ACL note).
export default function FilesRoute() {
  return <OrgFsFilesPage />;
}
