import { useWidget } from "./use-widget.ts";

type GreetingArgs = { name?: string; message?: string };

export default function Greeting() {
  const { args } = useWidget<GreetingArgs>();

  if (!args) return null;

  const { name = "World", message = "Welcome!" } = args;

  return (
    <div className="p-6 font-sans text-center">
      <div className="text-3xl mb-2">👋</div>
      <div className="text-xl font-bold text-foreground mb-1">
        Hello, {name}!
      </div>
      <div className="text-sm text-muted-foreground">{message}</div>
    </div>
  );
}
