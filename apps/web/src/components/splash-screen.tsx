import { Loading01 } from "@untitledui/icons";

export function SplashScreen() {
  return (
    <div className="flex items-center justify-center min-h-screen w-full">
      <Loading01 size={20} className="animate-spin text-muted-foreground" />
    </div>
  );
}
