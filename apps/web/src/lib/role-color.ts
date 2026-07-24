const ROLE_COLORS = [
  "bg-chart-1",
  "bg-chart-2",
  "bg-chart-3",
  "bg-chart-4",
  "bg-chart-5",
] as const;

const BUILTIN_ROLE_COLORS: Record<string, string> = {
  owner: "bg-destructive",
  admin: "bg-chart-1",
  user: "bg-success",
};

export function getRoleColor(roleName: string): string {
  if (!roleName) return "bg-muted-foreground";
  let hash = 0;
  for (let i = 0; i < roleName.length; i++) {
    const char = roleName.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  const index = Math.abs(hash) % ROLE_COLORS.length;
  return ROLE_COLORS[index]!;
}

export function getRoleDotColor(role: string, isBuiltin: boolean): string {
  if (isBuiltin) return BUILTIN_ROLE_COLORS[role] ?? "bg-muted-foreground";
  return getRoleColor(role);
}
