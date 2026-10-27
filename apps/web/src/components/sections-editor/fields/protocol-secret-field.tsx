import { useContentBackend } from "../use-content-backend";
import { useT } from "@/i18n/use-t.ts";
import { FieldLabel } from "./field-label";
import type { FieldProps } from "./field-props";
import { SecretField } from "./secret-field";

/**
 * Secret fields, by backend. A v7 site edits its secrets with the site's
 * own encrypt action. A Blocks v8 site (any content-protocol backend: a
 * hosted draft, a sandbox, a local `deco serve`) keeps its secrets in its
 * deploy platform, where its code reads them: content holds none (protocol
 * 1.2), so the editor has nothing to edit.
 */
export function SecretFieldForBackend(props: FieldProps) {
  const backend = useContentBackend(
    props.sandbox?.virtualMcpId,
    props.sandbox?.branch,
  );
  // A masked plain string, or a v7 site: the site's own encrypt action.
  if (backend.kind === "legacy" || props.schema.format === "password") {
    return <SecretField {...props} />;
  }
  // Undecided or unreachable: the legacy field would post plaintext to a site
  // that may be a protocol one, so nothing is editable until it's known.
  // Still being decided (briefly, while org settings load), it says nothing:
  // most sites are v7 and get their usual field a moment later.
  if (backend.kind !== "protocol") {
    return (
      <SecretMessage
        {...props}
        message={
          backend.kind === "unavailable"
            ? "sectionsEditor.secretField.backendUnavailableMessage"
            : null
        }
      />
    );
  }
  return (
    <SecretMessage
      {...props}
      message="sectionsEditor.secretField.platformSecretMessage"
    />
  );
}

function SecretMessage({
  schema,
  label,
  path,
  sandbox,
  message,
}: FieldProps & {
  message:
    | "sectionsEditor.secretField.backendUnavailableMessage"
    | "sectionsEditor.secretField.platformSecretMessage"
    | null;
}) {
  const t = useT();
  return (
    <div className="space-y-2">
      <FieldLabel
        htmlFor={path}
        label={label}
        description={schema.description}
        virtualMcpId={sandbox?.virtualMcpId}
      />
      {message && <p className="text-xs text-muted-foreground">{t(message)}</p>}
    </div>
  );
}
