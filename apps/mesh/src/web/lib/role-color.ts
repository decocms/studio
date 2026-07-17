const ROLE_COLORS = [
  "bg-red-500",
  "bg-orange-500",
  "bg-amber-500",
  "bg-yellow-500",
  "bg-lime-500",
  "bg-green-500",
  "bg-emerald-500",
  "bg-teal-500",
  "bg-cyan-500",
  "bg-sky-500",
  "bg-blue-500",
  "bg-indigo-500",
  "bg-violet-500",
  "bg-purple-500",
  "bg-fuchsia-500",
  "bg-pink-500",
  "bg-rose-500",
] as const;

const BUILTIN_ROLE_COLORS: Record<string, string> = {
  owner: "bg-red-500",
  admin: "bg-blue-500",
  user: "bg-green-500",
};

export function getRoleColor(roleName: string): string {
  if (!roleName) return "bg-neutral-400";
  let hash = 0;
  for (let i = 0; i < roleName.length; i++) {
    const char = roleName.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  const index = Math.abs(hash) % ROLE_COLORS.length;
  return ROLE_COLORS[index] ?? ROLE_COLORS[0];
}

export function getRoleDotColor(role: string, isBuiltin: boolean): string {
  if (isBuiltin) return BUILTIN_ROLE_COLORS[role] ?? "bg-neutral-400";
  return getRoleColor(role);
}
