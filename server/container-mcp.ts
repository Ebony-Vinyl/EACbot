// A stdio bridge into Cua Driver's MCP server in the Local VM. It defines no tools; the shared bridge only answers ping,
// makes tool schemas provider-safe and keeps error results text-only.
import { cuaExecArgs } from "./container-computer.ts";
import { runMcpBridge } from "./mcp-bridge.ts";

const [runtime, container, socket] = process.argv.slice(2);
if (!runtime || !["docker", "podman", "container"].includes(runtime)) {
  process.stderr.write("invalid Local VM runtime\n");
  process.exit(2);
}
if (!container || !/^[a-zA-Z0-9_.-]+$/.test(container) || !socket?.startsWith("/run/user/1000/")) {
  process.stderr.write("invalid Local VM connection\n");
  process.exit(2);
}

// The who-is-driving pair rides in env, not argv, which `ps` shows to everyone; the token guards a loopback endpoint.
const controlUrl = process.env.EAC_CONTROL_URL ?? "";
const controlToken = process.env.EAC_CONTROL_TOKEN ?? "";

runMcpBridge({
  command: runtime,
  args: cuaExecArgs(["mcp", "--socket", socket], { container, interactive: true }),
  label: "Cua Driver",
  // No liveness watchdog: the runtime CLI talks to a local daemon and fails fast on its own.
  // Required: a Local VM is shared by the person's screen and every turn, so a launch without the pair refuses computer
  // calls instead of letting both drive it. Every server mount supplies the pair; its absence means a wrong launch.
  gate: { url: controlUrl, token: controlToken, required: true },
});
