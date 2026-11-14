// Stdio bridge to the Cua MCP server in a VPS container; auth is the user's SSH config and agent, and nothing is stored here.
import { runMcpBridge } from "./mcp-bridge.ts";
import { vpsContainerMcpArgs, vpsDockerArgs } from "./vps-computer.ts";
import { DATA_DIR } from "./config.ts";
import { augmentedPath } from "./env-path.ts";
import { prepareVpsSsh } from "./vps-ssh.ts";

const [alias, containerName] = process.argv.slice(2);
const sshAlias = alias ?? "";
let args: string[];
try {
  args = vpsContainerMcpArgs(sshAlias, containerName ?? "");
} catch {
  process.stderr.write("invalid VPS MCP connection\n");
  process.exit(2);
}

// The driving pair rides in env, not argv: argv is world-readable through `ps`.
const controlUrl = process.env.EAC_CONTROL_URL ?? "";
const controlToken = process.env.EAC_CONTROL_TOKEN ?? "";
const ssh = prepareVpsSsh(DATA_DIR, augmentedPath());

runMcpBridge({
  command: "docker",
  args,
  env: { ...process.env, PATH: ssh.path },
  label: "VPS Cua Driver",
  // Probe the transport, not the driver: a busy desktop mid-tool-call must never look dead.
  liveness: { command: "docker", args: vpsDockerArgs(sshAlias, ["version", "--format", "{{.Server.Version}}"]) },
  // Required: a VPS desktop is remote and shared, so a launch without the pair refuses computer calls instead of letting
  // an AI act beside a person. Every server mount supplies the pair; its absence means a wrong launch.
  gate: { url: controlUrl, token: controlToken, required: true },
});
