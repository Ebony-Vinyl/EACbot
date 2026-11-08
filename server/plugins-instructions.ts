// The system-side contract for the eac-plugins MCP server: what its tools are and what a call may and may not assume.
export const PLUGINS_INSTRUCTIONS = [
  "These tools come from installed EACbot plugins. Each tool name names its plugin and tool; trust the description for what it does.",
  "Read-level tools run with the conversation's own authorization. A tool whose effect is a write, send, control or delete",
  "runs only when the owner has granted this bot that permission: a refusal names the missing grant, and the fix is the",
  "plugin's grants page, never a retry or a workaround. Report a plugin failure as the plugin's failure; do not present a",
  "refusal or an empty result as success.",
].join(" ");
