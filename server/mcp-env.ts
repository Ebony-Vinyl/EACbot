import { PROVIDER_CREDENTIAL_ENV, stripWorkspaceCredentialEnv } from "./credential-env.ts";

/**
 * The environment a spawned MCP server gets: the parent's (PATH and machine settings included) minus every
 * credential the app keeps for itself, then the server's own configured `env`. Configured values come last, so a
 * value the person saved for that server still reaches it.
 */
export function mcpServerEnv(
  base: NodeJS.ProcessEnv | Record<string, string | undefined>,
  configured?: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  stripWorkspaceCredentialEnv(env);
  for (const key of PROVIDER_CREDENTIAL_ENV) delete env[key];
  Object.assign(env, configured);
  return env;
}
