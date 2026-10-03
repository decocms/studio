import {
  encryptToCiphertext,
  SECRET_BLOCK_TYPE,
} from "@decocms/shared/blocks-protocol";
import { isSecretBlock as isV7SecretBlock } from "@decocms/shared/decofile";
import { useT } from "@/i18n/use-t.ts";
import { useContentBackend } from "../use-content-backend";
import { FieldLabel } from "./field-label";
import type { FieldProps } from "./field-props";
import { EncryptedSecretInput, SecretField } from "./secret-field";
import { protocolSecretState } from "./protocol-secret";

/**
 * Secret fields, by backend. On the content protocol a `Secret` field is
 * write-only: what an editor types is encrypted in the browser with the
 * site's public key (`describe.secrets`) and only the `secret` block with its
 * ciphertext is ever saved. v7 secrets need the site's own encrypt action,
 * which the protocol never runs, so they can't be edited there.
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
  if (backend.kind !== "protocol") {
    return (
      <SecretMessage
        {...props}
        message="sectionsEditor.secretField.backendUnavailableMessage"
      />
    );
  }
  if (isV7SecretBlock(props.value)) {
    return (
      <SecretMessage
        {...props}
        message="sectionsEditor.secretField.legacySecretUnavailableMessage"
      />
    );
  }
  return (
    <ProtocolSecretField
      {...props}
      publicKey={backend.describe.secrets?.publicKey ?? null}
    />
  );
}

function ProtocolSecretField({
  schema,
  value,
  onChange,
  label,
  path,
  sandbox,
  publicKey,
}: FieldProps & { publicKey: string | null }) {
  const t = useT();
  return (
    <div className="space-y-2">
      <FieldLabel
        htmlFor={path}
        label={label}
        description={schema.description}
        virtualMcpId={sandbox?.virtualMcpId}
      />
      {publicKey ? (
        <EncryptedSecretInput
          id={path}
          stored={protocolSecretState(value)}
          encrypt={(plaintext) => encryptToCiphertext(publicKey, plaintext)}
          onEncrypted={(ciphertext) =>
            onChange({ __resolveType: SECRET_BLOCK_TYPE, ciphertext })
          }
        />
      ) : (
        <p role="alert" className="text-xs text-muted-foreground">
          {t("sectionsEditor.secretField.noPublicKeyMessage")}
        </p>
      )}
    </div>
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
    | "sectionsEditor.secretField.legacySecretUnavailableMessage";
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
      <p className="text-xs text-muted-foreground">{t(message)}</p>
    </div>
  );
}
