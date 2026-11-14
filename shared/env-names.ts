/**
 * Environment names this app reads, with the names earlier releases used.
 *
 * A deployment configured before the rename keeps working: the process entry points call {@link adoptEarlierEnvNames}
 * once, which copies each earlier name onto its current one. The compatibility path is one call at startup rather
 * than a fallback in every reader, so a reader has exactly one name to look for.
 */

/** Earlier name -> current name. */
const EARLIER: Readonly<Record<string, string>> = {
  OPENMAUSBOT_URL: "EACBOT_URL",
  OPENMAUSBOT_TOKEN: "EACBOT_TOKEN",
  OPENMAUSBOT_MCP_TIMEOUT_MS: "EACBOT_MCP_TIMEOUT_MS",
  OPENMAUSBOT_COMPANY_API_KEY: "EACBOT_COMPANY_API_KEY",
  OPENMAUSBOT_CHATGPT_TOKEN: "EACBOT_CHATGPT_TOKEN",
  OPENMAUSBOT_CUA_SDK_LIBRARY: "EACBOT_CUA_SDK_LIBRARY",
  OPENMAUSBOT_CUA_ARCHES: "EACBOT_CUA_ARCHES",
  OPENMAUSBOT_CUA_ARCHES_PARTIAL: "EACBOT_CUA_ARCHES_PARTIAL",
  OPENMAUSBOT_CUA_ARCHIVE_PATH: "EACBOT_CUA_ARCHIVE_PATH",
  OPENMAUSBOT_CUA_EMBEDDED: "EACBOT_CUA_EMBEDDED",
  OPENMAUSBOT_CUA_OFFLINE: "EACBOT_CUA_OFFLINE",
  OPENMAUSBOT_PROBE_LOCAL_INJECT: "EACBOT_PROBE_LOCAL_INJECT",
  OPENMAUSBOT_POSTINSTALL_TEST_ROOT: "EACBOT_POSTINSTALL_TEST_ROOT",
  OPENMAUSBOT_TRIAL_CREDIT_KEY: "EACBOT_TRIAL_CREDIT_KEY",
  MAUSBOT_CONNECTOR_IMAGE: "EACBOT_CONNECTOR_IMAGE",
  MAUSBOT_UPDATE_WAIT_S: "EACBOT_UPDATE_WAIT_S",
  MAUSBOT_INSTANCE: "EACBOT_INSTANCE",
  MAUSBOT_ADMIN_URL: "EACBOT_ADMIN_URL",
  MAUSBOT_TOKEN: "EACBOT_TOKEN",
  MAUSBOT_TOOL_DEFINITIONS: "EACBOT_TOOL_DEFINITIONS",
  MAUSBOT_TOOL_NAMES: "EACBOT_TOOL_NAMES",
};

/** The earlier names in force for this process, so a caller can say once that a setting was renamed. */
export function adoptEarlierEnvNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const adopted: string[] = [];
  for (const [earlier, current] of Object.entries(EARLIER)) {
    const value = env[earlier];
    if (value === undefined || value === "") continue;
    // A value written under the current name wins: it is the one the docs describe.
    if (env[current] === undefined || env[current] === "") env[current] = value;
    adopted.push(`${earlier} -> ${current}`);
  }
  return adopted;
}
