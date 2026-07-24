import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Plus, Trash01 } from "@untitledui/icons";

/**
 * Check if an env var key looks like it contains sensitive data
 *
 * Covers patterns from major platforms:
 * - AWS (ACCESS_KEY, SECRET_ACCESS_KEY, SESSION_TOKEN)
 * - Stripe (sk_, STRIPE_SECRET, WEBHOOK_SECRET)
 * - OpenAI/Anthropic/Cohere/Perplexity (API_KEY)
 * - Supabase (SERVICE_ROLE_KEY, JWT_SECRET, ANON_KEY)
 * - Vercel/Netlify/Heroku (AUTH_TOKEN)
 * - GitHub/GitLab (PAT, GH_TOKEN)
 * - Cloudflare (CF_API_TOKEN)
 * - Twilio (AUTH_TOKEN, API_SECRET)
 * - SendGrid/Resend (API_KEY)
 * - Firebase/GCP (PRIVATE_KEY, SERVICE_ACCOUNT)
 * - Sentry/Datadog/New Relic (DSN, LICENSE_KEY)
 * - Database URLs often contain embedded passwords
 * - OAuth (CLIENT_SECRET, REFRESH_TOKEN)
 */
function isSensitiveKey(key: string): boolean {
  const lowerKey = key.toLowerCase();

  // Generic patterns that indicate secrets
  const sensitivePatterns = [
    // Core secret indicators
    "secret",
    "password",
    "passwd",
    "credential",
    "private",

    // Token patterns
    "token",
    "bearer",
    "jwt",
    "refresh",
    "session",

    // Key patterns (but not keyboard/keycode etc)
    "api_key",
    "apikey",
    "auth_key",
    "access_key",
    "secret_key",
    "private_key",
    "service_key",
    "encryption_key",
    "signing_key",
    "license_key",

    // Auth patterns
    "auth",
    "oauth",
    "client_secret",
    "app_secret",

    // Webhook/signing
    "webhook",
    "signing",
    "signature",

    // Database/connection strings (often contain embedded passwords)
    "database_url",
    "db_url",
    "mongo_uri",
    "redis_url",
    "postgres_url",
    "mysql_url",
    "connection_string",
    "dsn",

    // Platform-specific patterns
    "service_role", // Supabase
    "anon_key", // Supabase
    "supabase_key",
    "openai",
    "anthropic",
    "stripe",
    "twilio",
    "sendgrid",
    "resend",
    "firebase",
    "sentry",
    "datadog",
    "newrelic",
    "new_relic",
    "pplx", // Perplexity
    "replicate",
    "pinecone",
    "cohere",
    "hugging", // HuggingFace
    "hf_token",
    "gh_token", // GitHub
    "npm_token",

    // Certificate/encryption
    "certificate",
    "cert",
    "ssl",
    "tls",
    "encryption",
    "salt",
    "hash",
    "hmac",

    // Personal access tokens
    "personal_access",
    "github_pat",
    "gitlab_pat",
    "bitbucket_pat",
  ];

  // Check if key contains any sensitive pattern
  if (sensitivePatterns.some((pattern) => lowerKey.includes(pattern))) {
    return true;
  }

  // Check for common prefixes that indicate secrets (Stripe, etc)
  const secretPrefixes = ["sk_", "rk_", "whsec_", "pk_live", "sk_live"];
  if (secretPrefixes.some((prefix) => lowerKey.startsWith(prefix))) {
    return true;
  }

  // Check if it ends with common secret suffixes
  const secretSuffixes = [
    "_key",
    "_secret",
    "_token",
    "_password",
    "_auth",
    "_pat", // Personal Access Token (but not _path)
  ];
  if (secretSuffixes.some((suffix) => lowerKey.endsWith(suffix))) {
    return true;
  }

  return false;
}

export interface EnvVar {
  key: string;
  value: string;
}

interface EnvVarsEditorProps {
  value: EnvVar[];
  onChange: (envVars: EnvVar[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  className?: string;
}

export function EnvVarsEditor({
  value,
  onChange,
  keyPlaceholder = "VARIABLE_NAME",
  valuePlaceholder = "value...",
  className,
}: EnvVarsEditorProps) {
  const handleAdd = () => {
    onChange([...value, { key: "", value: "" }]);
  };

  const handleRemove = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
  };

  const handleKeyChange = (index: number, key: string) => {
    const newEnvVars = [...value];
    const current = newEnvVars[index];
    if (current) {
      newEnvVars[index] = { key, value: current.value };
      onChange(newEnvVars);
    }
  };

  const handleValueChange = (index: number, newValue: string) => {
    const newEnvVars = [...value];
    const current = newEnvVars[index];
    if (current) {
      newEnvVars[index] = { key: current.key, value: newValue };
      onChange(newEnvVars);
    }
  };

  return (
    <div className={className}>
      <div className="flex flex-col gap-2">
        {value.map((envVar, index) => (
          <div key={index} className="flex gap-2 items-center">
            <Input
              placeholder={keyPlaceholder}
              value={envVar.key}
              onChange={(e) => handleKeyChange(index, e.target.value)}
              className="h-10 rounded-lg flex-1 font-mono text-sm"
            />
            <Input
              type={isSensitiveKey(envVar.key) ? "password" : "text"}
              placeholder={valuePlaceholder}
              value={envVar.value}
              onChange={(e) => handleValueChange(index, e.target.value)}
              className="h-10 rounded-lg flex-1"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-10 w-10 shrink-0 text-muted-foreground hover:text-destructive"
              onClick={() => handleRemove(index)}
            >
              <Trash01 size={16} />
            </Button>
          </div>
        ))}

        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full h-9 text-muted-foreground"
          onClick={handleAdd}
        >
          <Plus size={16} className="mr-1" />
          Add Environment Variable
        </Button>
      </div>
    </div>
  );
}

/**
 * Convert EnvVar array to Record for API
 */
export function envVarsToRecord(envVars: EnvVar[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const { key, value } of envVars) {
    if (key.trim()) {
      record[key.trim()] = value;
    }
  }
  return record;
}

/**
 * Convert Record to EnvVar array for form
 */
export function recordToEnvVars(
  record: Record<string, string> | undefined | null,
): EnvVar[] {
  if (!record) return [];
  return Object.entries(record).map(([key, value]) => ({ key, value }));
}
