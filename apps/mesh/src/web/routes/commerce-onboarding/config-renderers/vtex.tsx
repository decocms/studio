import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Loading01 } from "@untitledui/icons";
import { useState } from "react";
import type { CompanionConfigRendererProps } from "./types.ts";

export function VtexRenderer({
  currentValue,
  saving,
  error,
  onSave,
}: CompanionConfigRendererProps) {
  const [accountName, setAccountName] = useState(
    (currentValue.accountName as string | undefined) ?? "",
  );
  const [appKey, setAppKey] = useState(
    (currentValue.appKey as string | undefined) ?? "",
  );
  const [appToken, setAppToken] = useState(
    (currentValue.appToken as string | undefined) ?? "",
  );

  return (
    <div className="flex flex-col gap-2">
      <Input
        value={accountName}
        onChange={(e) => setAccountName(e.target.value)}
        placeholder="Account name"
      />
      <Input
        type="password"
        value={appKey}
        onChange={(e) => setAppKey(e.target.value)}
        placeholder="App key"
      />
      <Input
        type="password"
        value={appToken}
        onChange={(e) => setAppToken(e.target.value)}
        placeholder="App token"
      />
      <div className="flex items-center justify-end">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={saving}
          onClick={() => onSave({ accountName, appKey, appToken })}
        >
          {saving ? <Loading01 size={16} className="animate-spin" /> : "Save"}
        </Button>
      </div>
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
