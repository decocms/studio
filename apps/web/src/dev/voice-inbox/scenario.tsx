import { useState } from "react";
import { Button } from "@decocms/ui/components/button.tsx";
import { useT } from "@/i18n/use-t";
import { VoiceInboxPrototype } from "./prototype";
import {
  FIXTURE_KEY,
  fixtureSchema,
  readFixture,
  storageKey,
} from "./scenario-data";

export function ScenarioLoader() {
  const t = useT();
  const [fixture, setFixture] = useState(readFixture);
  const [selected, setSelected] = useState(0);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState(false);
  return (
    <VoiceInboxPrototype
      key={`${revision}-${selected}`}
      scenario={fixture?.scenarios[selected]}
      personName={fixture?.name}
      organization={fixture?.organization}
      branding={fixture?.branding}
      mockControls={
        <div className="flex flex-col gap-3 p-2">
          <p className="text-muted-foreground">{t("voiceInbox.localOnly")}</p>
          <label className="flex flex-col gap-2">
            {t("voiceInbox.import")}
            <input
              type="file"
              accept="application/json,.json"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                try {
                  if (file.size > 500000) throw new Error("Fixture too large");
                  const next = fixtureSchema.parse(
                    JSON.parse(await file.text()),
                  );
                  localStorage.setItem(FIXTURE_KEY, JSON.stringify(next));
                  for (const scenario of next.scenarios)
                    localStorage.removeItem(storageKey(scenario));
                  setFixture(next);
                  setSelected(0);
                  setRevision(revision + 1);
                  setError(false);
                } catch {
                  setError(true);
                }
              }}
            />
          </label>
          {error && <p role="alert">{t("voiceInbox.importError")}</p>}
          {fixture?.scenarios.map((scenario, index) => (
            <Button
              key={scenario.id}
              size="sm"
              variant={selected === index ? "default" : "outline"}
              onClick={() => setSelected(index)}
            >
              {scenario.label}
            </Button>
          ))}
        </div>
      }
    />
  );
}
