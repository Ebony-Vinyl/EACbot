/** Environment handed to a native agent process.
 *
 * Two rules, both enforced here rather than trusted from the caller:
 * 1. Only an allowlist of names crosses from the host environment. An inherited provider key
 *    would silently move a subscription engine onto API billing.
 * 2. Control-plane secrets never cross, in any casing and under any historical name. */

/** Host variables an agent process may legitimately read: locale, terminals, proxy and certs,
 * plus the Windows/Unix home and temp locations it needs to find its own config. */
export const ALLOWED_ENV_NAMES: readonly string[] = [
  "PATH", "HOME", "USERPROFILE", "USER", "LOGNAME", "USERNAME",
  "TMPDIR", "TEMP", "TMP", "SystemRoot", "SYSTEMROOT", "COMSPEC", "PATHEXT",
  "LANG", "LC_ALL", "LC_CTYPE", "LANGUAGE", "TZ",
  "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "SHELL", "PWD", "EDITOR", "VISUAL",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
];

/** Names that identify a billing identity. They cross only when the instance's auth mode names
 * that exact key, never by inheritance. */
export const BILLING_ENV_NAMES: readonly string[] = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID",
  "OPENROUTER_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY",
  "XAI_API_KEY", "GROQ_API_KEY", "DEEPSEEK_API_KEY", "MISTRAL_API_KEY",
  "CEREBRAS_API_KEY", "MOONSHOT_API_KEY", "KIMI_API_KEY", "MINIMAX_API_KEY",
  "ZAI_API_KEY", "GLM_API_KEY", "OPENCODE_API_KEY", "CLINE_API_KEY",
  "CURSOR_API_KEY", "CURSOR_AUTH_TOKEN", "FACTORY_API_KEY",
];

/** This control plane's own secrets. Never handed to an agent, under any name. */
export const CONTROL_PLANE_ENV_NAMES: readonly string[] = [
  "EAC_LICENSE_KEY", "EAC_INSTALLATION_CREDENTIAL", "EACBOT_TOKEN", "EACBOT_COMPANY_API_KEY",
  "EACBOT_CHATGPT_TOKEN", "EACBOT_ADMIN_URL", "EACBOT_CLOUD_AI_TOKEN",
  "OPENMAUSBOT_TOKEN", "OPENMAUSBOT_COMPANY_API_KEY", "OPENMAUSBOT_CHATGPT_TOKEN",
  "MAUSBOT_TOKEN", "MAUSBOT_COMPANY_API_KEY", "MAUSBOT_CHATGPT_TOKEN",
];

const CONTROL_PLANE_PREFIXES = ["EAC_CLOUD_", "EACBOT_", "OPENMAUSBOT_", "MAUSBOT_"] as const;

function upper(name: string): string {
  // Windows environment names compare case-insensitively; so do these rules everywhere.
  return name.toUpperCase();
}

export function isControlPlaneName(name: string): boolean {
  const key = upper(name);
  return (
    (CONTROL_PLANE_ENV_NAMES as readonly string[]).includes(key) ||
    CONTROL_PLANE_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

export function isBillingName(name: string): boolean {
  return (BILLING_ENV_NAMES as readonly string[]).includes(upper(name));
}

export type AuthMode = "subscription" | "apiKey" | "compatibleEndpoint" | "local";

export interface AuthConfig {
  mode: AuthMode;
  /** For `apiKey`: the one credential name this instance may carry, and its value. */
  apiKey?: { name: string; value: string };
  /** For `compatibleEndpoint`: the base URL and the credential name it needs, if any. */
  compatibleEndpoint?: { baseUrl: string; apiKeyName?: string; apiKeyValue?: string };
  /** For `local`: where the local server listens. */
  local?: { baseUrl: string };
}

export interface EnvBuildInput {
  /** The host environment to draw the allowlist from. */
  host: Record<string, string | undefined>;
  /** Per-instance overrides (HOME, config dir) that always win. */
  instance?: Record<string, string | undefined>;
  auth: AuthConfig;
}

/** The exact environment one agent process gets. */
export function buildAgentEnv(input: EnvBuildInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ALLOWED_ENV_NAMES) {
    const value = input.host[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  for (const [name, value] of Object.entries(input.instance ?? {})) {
    if (value === undefined || value === "") continue;
    if (isControlPlaneName(name)) continue;
    env[name] = value;
  }
  applyAuth(env, input.auth);
  for (const name of Object.keys(env)) {
    if (isControlPlaneName(name)) delete env[name];
  }
  return env;
}

/** A billing identity belongs to exactly one auth mode. A key named for another mode is a
 * configuration error, not something to drop silently: the person asked for billing that
 * cannot happen. */
function applyAuth(env: Record<string, string>, auth: AuthConfig): void {
  const named = auth.apiKey?.name ?? auth.compatibleEndpoint?.apiKeyName;
  if (named !== undefined && !isBillingName(named)) {
    throw new Error(`"${named}" is not a provider credential name`);
  }
  if (auth.mode === "apiKey") {
    if (!auth.apiKey) throw new Error("apiKey auth needs a key");
    env[auth.apiKey.name] = auth.apiKey.value;
    return;
  }
  if (auth.mode === "compatibleEndpoint") {
    const endpoint = auth.compatibleEndpoint;
    if (!endpoint) throw new Error("compatibleEndpoint auth needs a base URL");
    env.AGENT_BASE_URL = endpoint.baseUrl;
    if (endpoint.apiKeyName && endpoint.apiKeyValue) env[endpoint.apiKeyName] = endpoint.apiKeyValue;
    return;
  }
  if (auth.mode === "local") {
    if (!auth.local) throw new Error("local auth needs a base URL");
    env.AGENT_BASE_URL = auth.local.baseUrl;
  }
}

/** Whether a mode requires a stored credential at all. A subscription signs in with the engine's
 * own flow, and a local endpoint needs none. */
export function requiresCredential(auth: AuthConfig): boolean {
  return auth.mode === "apiKey" || (auth.mode === "compatibleEndpoint" && Boolean(auth.compatibleEndpoint?.apiKeyName));
}
