import { useRef, useState } from "react";
import { useT } from "@/i18n/use-t.ts";
import { useVirtualMCP } from "@/sdk/hooks/use-virtual-mcp";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { resolvePreviewServerUrl } from "@decocms/shared/deco-site-production-url";
import {
  isEncryptedSecretValue,
  isSecretBlock,
  SECRET_LOADER_RESOLVE_TYPE,
} from "@decocms/shared/decofile";
import type { SchemaProperty } from "../resolve-schema";
import type { FieldProps } from "./field-props";
import { FieldLabel } from "./field-label";
import {
  encryptSiteSecret,
  secretEncryptionSiteUrls,
} from "./secret-encryption";

/** `@format secret` is the loader's `encrypted` prop; `password` is a plain masked string. */
export function isSecretField(schema: SchemaProperty, value: unknown): boolean {
  return (
    isSecretBlock(value) ||
    schema.format === "secret" ||
    schema.format === "password"
  );
}

type EncryptSecret = (value: string) => Promise<string>;

/**
 * Deco API secrets are `website/loaders/secret.ts` blocks (`name` + `encrypted`).
 * The runtime only decrypts, so the raw value is encrypted by the site's own
 * action before anything reaches the form; stored secrets are never displayed.
 */
export function SecretField({
  schema,
  value,
  onChange,
  label,
  path,
  sandbox,
}: FieldProps) {
  const t = useT();
  const metadata = useVirtualMCP(sandbox?.virtualMcpId)?.metadata;
  const siteUrls = secretEncryptionSiteUrls({
    siteSlug: metadata?.siteSlug,
    previewServerUrl: resolvePreviewServerUrl(metadata),
  });
  const encrypt: EncryptSecret = (plaintext) =>
    encryptSiteSecret(plaintext, siteUrls);
  const labelNode = (htmlFor: string) => (
    <FieldLabel
      htmlFor={htmlFor}
      label={label}
      description={schema.description}
      virtualMcpId={sandbox?.virtualMcpId}
    />
  );

  if (!isSecretBlock(value) && schema.format === "password") {
    return (
      <div className="space-y-2">
        {labelNode(path)}
        <PlainPasswordInput id={path} value={value} onChange={onChange} />
      </div>
    );
  }

  if (!isSecretBlock(value)) {
    return (
      <div className="space-y-2">
        {labelNode(path)}
        <EncryptedSecretInput
          id={path}
          stored={storedSecretState(value)}
          encrypt={encrypt}
          onEncrypted={onChange}
        />
      </div>
    );
  }

  const { value: _legacyPlaintext, ...block } = value;
  const name = typeof block.name === "string" ? block.name : "";

  return (
    <div className="space-y-2">
      {labelNode(`${path}-name`)}
      <Input
        id={`${path}-name`}
        value={name}
        placeholder={t("sectionsEditor.secretField.secretNamePlaceholder")}
        onChange={(e) => onChange({ ...block, name: e.target.value })}
        className="h-10"
      />
      <EncryptedSecretInput
        id={`${path}-value`}
        stored={storedSecretState(block.encrypted)}
        encrypt={encrypt}
        onEncrypted={(encrypted) =>
          onChange({
            __resolveType: SECRET_LOADER_RESOLVE_TYPE,
            ...block,
            encrypted,
          })
        }
      />
    </div>
  );
}

type StoredSecretState = "none" | "encrypted" | "plaintext";

function storedSecretState(encrypted: unknown): StoredSecretState {
  if (encrypted === undefined || encrypted === null || encrypted === "") {
    return "none";
  }
  return isEncryptedSecretValue(encrypted) ? "encrypted" : "plaintext";
}

/**
 * Holds the typed secret only in local state, commits it on Enter, blur, or the
 * button, and emits nothing but the site's hex. A failed encryption emits
 * nothing, so the pending secret can't reach the autosave.
 */
function EncryptedSecretInput({
  id,
  stored,
  encrypt,
  onEncrypted,
}: {
  id: string;
  stored: StoredSecretState;
  encrypt: EncryptSecret;
  onEncrypted: (encrypted: string) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<"idle" | "encrypting" | "failed">(
    "idle",
  );

  // Enter and the blur that follows can fire from the same render; a ref sees the in-flight call.
  const inFlight = useRef(false);

  const commit = async () => {
    if (!draft || inFlight.current) return;
    inFlight.current = true;
    setStatus("encrypting");
    try {
      const encrypted = await encrypt(draft);
      setDraft("");
      setStatus("idle");
      onEncrypted(encrypted);
    } catch {
      setStatus("failed");
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex gap-2">
        <Input
          id={id}
          type="password"
          value={draft}
          disabled={status === "encrypting"}
          autoComplete="new-password"
          autoCorrect="off"
          spellCheck={false}
          placeholder={
            stored === "encrypted"
              ? t("sectionsEditor.secretField.leaveBlankPlaceholder")
              : t("sectionsEditor.secretField.secretValuePlaceholder")
          }
          onChange={(e) => {
            setDraft(e.target.value);
            if (status === "failed") setStatus("idle");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            }
          }}
          onBlur={() => void commit()}
          className="h-10"
        />
        <Button
          type="button"
          variant="outline"
          className="h-10"
          disabled={!draft || status === "encrypting"}
          onClick={() => void commit()}
        >
          {t("sectionsEditor.secretField.encryptButton")}
        </Button>
      </div>
      {status === "failed" ? (
        <p role="alert" className="text-xs text-destructive">
          {t("sectionsEditor.secretField.encryptFailedMessage")}
        </p>
      ) : status === "encrypting" ? (
        <p className="text-xs text-muted-foreground">
          {t("sectionsEditor.secretField.encryptingMessage")}
        </p>
      ) : draft ? (
        <p className="text-xs text-muted-foreground">
          {t("sectionsEditor.secretField.pendingMessage")}
        </p>
      ) : stored === "plaintext" ? (
        <p role="alert" className="text-xs text-destructive">
          {t("sectionsEditor.secretField.plaintextStoredMessage")}
        </p>
      ) : stored === "encrypted" ? (
        <p className="text-xs text-muted-foreground">
          {t("sectionsEditor.secretField.storedSecretMessage")}
        </p>
      ) : null}
    </div>
  );
}

/**
 * `@format password` on a plain `string` prop: the section reads the raw
 * string, so it stays plaintext, but the stored value is never displayed.
 * Clearing the input restores the value the field opened with.
 */
function PlainPasswordInput({
  id,
  value,
  onChange,
}: {
  id: string;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const t = useT();
  const [stored] = useState(value);
  const [draft, setDraft] = useState("");
  const hasStored = typeof stored === "string" && stored.length > 0;
  return (
    <Input
      id={id}
      type="password"
      value={draft}
      autoComplete="new-password"
      autoCorrect="off"
      spellCheck={false}
      placeholder={
        hasStored
          ? t("sectionsEditor.secretField.leaveBlankPlaceholder")
          : t("sectionsEditor.secretField.secretValuePlaceholder")
      }
      onChange={(e) => {
        setDraft(e.target.value);
        onChange(e.target.value || stored);
      }}
      className="h-10"
    />
  );
}
