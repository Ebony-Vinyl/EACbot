// Credential env names and the strippers that keep them out of child processes. Lives apart from
// config.ts so the lists can grow (one name per engine) without that file growing with them.

/** Workspace credential env names; spawned engine CLIs must never inherit them. */
export const WORKSPACE_CREDENTIAL_ENV = [
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "CEREBRAS_API_KEY",
  "EAC_GROQ_API_KEY",
  "EAC_GREENFERENCE_API_KEY",
  "EAC_META_API_KEY",
  "EAC_DEEPSEEK_API_KEY",
  "EAC_ANTHROPIC_API_KEY",
  "EAC_ANTHROPIC_API_URL",
  "EAC_HOSTED_MODEL_TOKEN",
  "EAC_HOSTED_MODELS",
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_COMPAT_URL",
  "EAC_OPENAI_API_KEY",
  "EAC_OPENROUTER_API_KEY",
  "BOX_TOKEN",
  "OPENCODE_API_KEY",
  "EAC_TTS_KEY",
  "EAC_FISH_AUDIO_API_KEY",
  "EAC_GEMINI_API_KEY",
  "EAC_JEV_API_KEY",
  "EAC_OPENROUTER_DECIDER_KEY",
  "EAC_WORKERS_AI_TOKEN",
  "EAC_OPENAI_IMAGE_KEY",
  "EAC_CUSTOM_IMAGE_KEY",
  "EAC_GEMINI_IMAGE_KEY",
  "EAC_OPENAI_LIVE_KEY", "EAC_TREG_KEY", "EAC_POSTIZ_API_KEY",
  "COMPOSIO_API_KEY",
  "EAC_COMPOSIO_BROKER_TOKEN",
  "EAC_CLOUD_BOAT_TOKEN",
  "EAC_CLOUD_VOICE_TOKEN",
  "EAC_CLOUD_DECIDER_TOKEN",
  "EAC_CLOUD_AI_TOKEN", "EAC_CLOUD_X_TOKEN", "EAC_CLOUD_CONNECTED_APPS_GRANT",
  // Not credentials, but they point a shell-capable agent at app-owned state.
  "EAC_BROWSER_CONNECTION", "EAC_USER_DATA", "EAC_BOAT_API",
] as const;

/** Operator secrets only this process reads, plus every `EAC_CLOUD_` var (the underscore leaves out EAC_CLOUDFLARED_PATH). */
export const CONTROL_PLANE_ENV = ["EAC_LICENSE_KEY", "EAC_INSTALLATION_CREDENTIAL"] as const;
export const CONTROL_PLANE_ENV_PREFIX = "EAC_CLOUD_";

/** Names compare case-insensitively because Windows environments do. */
export function stripControlPlaneEnv(env: Record<string, string | undefined>): void {
  for (const key of Object.keys(env)) {
    const name = key.toUpperCase();
    if (name.startsWith(CONTROL_PLANE_ENV_PREFIX) || (CONTROL_PLANE_ENV as readonly string[]).includes(name)) delete env[key];
  }
}

export function stripWorkspaceCredentialEnv(env: Record<string, string | undefined>): void {
  for (const key of WORKSPACE_CREDENTIAL_ENV) delete env[key];
  stripControlPlaneEnv(env);
}

/** Env a provider CLI may read as its billing identity; a foreign key must never move a subscription CLI onto API billing. */
export const PROVIDER_CREDENTIAL_ENV = [
  "CLINE_API_KEY",
  "ANTHROPIC_API_KEY",
  "FACTORY_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "KIMI_API_KEY",
  "MOONSHOT_API_KEY",
  "MINIMAX_API_KEY",
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "CEREBRAS_API_KEY",
  "GROQ_API_KEY",
  "GREENFERENCE_API_KEY",
  "META_API_KEY",
  "DEEPSEEK_API_KEY",
  "CURSOR_API_KEY",
  "CURSOR_AUTH_TOKEN",
] as const;

/** Provider keys OpenCode reads from its environment (with ANTHROPIC_API_KEY set it lists Anthropic's models). */
export const OPENCODE_PROVIDER_ENV = [
  "CLINE_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "KIMI_API_KEY",
  "MOONSHOT_API_KEY",
  "MINIMAX_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
] as const;
