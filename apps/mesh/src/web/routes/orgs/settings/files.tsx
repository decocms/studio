import { Navigate, useParams } from "@tanstack/react-router";

// The Files browser moved to the top-level Library (/$org/files). Keep the
// old settings URL alive as a redirect for bookmarks/old links.
export default function FilesRoute() {
  const { org } = useParams({ strict: false }) as { org: string };
  return <Navigate to="/$org/files" params={{ org }} replace />;
}
