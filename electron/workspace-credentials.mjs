export const WORKSPACE_CREDENTIALS = [
  { section: "xai", field: "key", name: "xaiApiKey", env: "XAI_API_KEY" },
  { section: "box", field: "token", name: "boxToken", env: "BOX_TOKEN" },
  { section: "tts", field: "key", name: "ttsKey", env: "EAC_TTS_KEY" },
  { section: "tts", field: "fishKey", name: "fishAudioKey", env: "EAC_FISH_AUDIO_API_KEY" },
  { section: "tts", field: "geminiKey", name: "geminiTtsKey", env: "EAC_GEMINI_API_KEY" },
  { section: "decider", field: "key", name: "jevApiKey", env: "EAC_JEV_API_KEY" },
  { section: "decider", field: "openrouterKey", name: "openrouterDeciderKey", env: "EAC_OPENROUTER_DECIDER_KEY" },
  { section: "decider", field: "workersAiToken", name: "workersAiToken", env: "EAC_WORKERS_AI_TOKEN" },
  { section: "imageGen", field: "key", name: "openaiImageApiKey", env: "EAC_OPENAI_IMAGE_KEY" },
  { section: "imageGen", field: "customApiKey", name: "customImageApiKey", env: "EAC_CUSTOM_IMAGE_KEY" },
  { section: "imageGen", field: "geminiKey", name: "geminiImageApiKey", env: "EAC_GEMINI_IMAGE_KEY" },
  { section: "live", field: "key", name: "openaiLiveKey", env: "EAC_OPENAI_LIVE_KEY" },
  { section: "treg", field: "key", name: "tregApiKey", env: "EAC_TREG_KEY" },
  { section: "postiz", field: "key", name: "postizApiKey", env: "EAC_POSTIZ_API_KEY" },
  { section: "opencodeGo", field: "apiKey", name: "opencodeGoApiKey", env: "OPENCODE_API_KEY" },
];

/** Moves plaintext secrets into the store and deletes the field. "" never drops a stored secret: every packaged
 * credential save writes an empty tombstone to config.json. The caller persists credentials before config. */
export function migrateWorkspaceCredentials(config, credentials) {
  const nextConfig = structuredClone(config ?? {});
  const nextCredentials = { ...credentials };
  let configChanged = false;
  let credentialsChanged = false;
  for (const { section, field, name } of WORKSPACE_CREDENTIALS) {
    const home = nextConfig?.[section];
    if (!home || typeof home !== "object" || Array.isArray(home)) continue;
    if (!Object.hasOwn(home, field)) continue;
    const value = home[field];
    if (typeof value !== "string") continue;
    const secret = value.trim();
    if (secret && nextCredentials[name] !== secret) {
      nextCredentials[name] = secret;
      credentialsChanged = true;
    }
    delete home[field];
    configChanged = true;
  }
  return { config: nextConfig, credentials: nextCredentials, configChanged, credentialsChanged };
}

export function workspaceCredentialEnv(credentials) {
  const env = {};
  for (const { name, env: envName } of WORKSPACE_CREDENTIALS) {
    const value = credentials?.[name];
    if (typeof value === "string" && value) env[envName] = value;
  }
  return env;
}
