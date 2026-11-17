import { describe, expect, it } from "vitest";

import {
  checkSentinelInstall, launchdPlist, sentinelCommand, sentinelLaunchdPlist, sentinelServicePlan, sentinelSystemdService, sentinelSystemdTimer,
  sentinelUnitCommand, serviceCommand, servicePlan, shippedSentinelCli, systemdUnit, unstableInstallWarning, type ServiceSpec,
} from "./service-unit.ts";

const spec: ServiceSpec = {
  node: "/usr/bin/node",
  script: "/usr/lib/node_modules/eacbot/cli.js",
  serveArgs: ["--port", "8799", "--data-dir", "/home/eacbot/.eacbot", "--domain", "eacbot.example.com", "--no-pair"],
  dataDir: "/home/eacbot/.eacbot",
  user: "eacbot",
  home: "/home/eacbot",
  bindsLowPorts: true,
  label: "agentada",
};

describe("service units", () => {
  it("runs the same serve command, with strip-types only for a checkout", () => {
    expect(serviceCommand(spec)).toEqual(["/usr/bin/node", "/usr/lib/node_modules/eacbot/cli.js", "serve", ...spec.serveArgs]);
    expect(serviceCommand({ ...spec, script: "/srv/EACbot/server/eacbot.ts" })[1]).toBe("--experimental-strip-types");
  });

  it("renders a systemd unit that restarts, runs as the user, and grants low ports only for --domain", () => {
    const unit = systemdUnit(spec);
    expect(unit).toContain("Description=EACbot (agentada)");
    expect(unit).toContain("User=eacbot");
    expect(unit).toContain("Environment=EAC_DATA_DIR=/home/eacbot/.eacbot");
    expect(unit).toContain("ExecStart=/usr/bin/node /usr/lib/node_modules/eacbot/cli.js serve --port 8799 --data-dir /home/eacbot/.eacbot --domain eacbot.example.com --no-pair");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("AmbientCapabilities=CAP_NET_BIND_SERVICE");
    expect(unit).toContain("WantedBy=multi-user.target");
    const local = systemdUnit({ ...spec, bindsLowPorts: false, serveArgs: ["--port", "8799", "--data-dir", "/home/eacbot/.eacbot"] });
    expect(local).not.toContain("CAP_NET_BIND_SERVICE");
    expect(systemdUnit({ ...spec, dataDir: "/home/eacbot/My Data", serveArgs: ["--data-dir", "/home/eacbot/My Data"] })).toContain('ExecStart=/usr/bin/node /usr/lib/node_modules/eacbot/cli.js serve --data-dir "/home/eacbot/My Data"');
  });

  it("renders a launchd agent that keeps the server alive and logs under the data dir", () => {
    const plist = launchdPlist({ ...spec, home: "/Users/eacbot", dataDir: "/Users/eacbot/.eacbot" });
    expect(plist).toContain("<string>com.eacbot.serve</string>");
    expect(plist).toContain("<string>/usr/bin/node</string>");
    expect(plist).toContain("<string>serve</string>");
    expect(plist).toContain("<string>eacbot.example.com</string>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("/Users/eacbot/.eacbot/logs/service.log");
    expect(launchdPlist({ ...spec, serveArgs: ["--label", "a & b <c>"] })).toContain("<string>a &amp; b &lt;c&gt;</string>");
  });

  it("refuses to point a service at an npx cache, and knows where each platform's file goes", () => {
    expect(unstableInstallWarning("/home/eacbot/.npm/_npx/abc123/node_modules/eacbot/cli.js")).toMatch(/npm install -g eacbot/);
    expect(unstableInstallWarning("/usr/lib/node_modules/eacbot/cli.js")).toBeNull();
    const linux = servicePlan("linux", "/home/eacbot/.eacbot");
    expect(linux?.installed).toBe("/etc/systemd/system/eacbot.service");
    expect(linux?.activate.join("\n")).toContain("systemctl enable --now eacbot");
    const mac = servicePlan("darwin", "/Users/eacbot/.eacbot", "/Users/eacbot");
    expect(mac?.installed).toBe("/Users/eacbot/Library/LaunchAgents/com.eacbot.serve.plist");
    expect(mac?.activate.join("\n")).toContain("launchctl bootstrap gui/$(id -u)");
    expect(servicePlan("win32", "C:\\x")).toBeNull();
  });

  it("renders Sentinel as a launchd agent on an interval, under its own label, logging outside the data dir", () => {
    const out = "/Users/eacbot/Library/Application Support/eacbot-sentinel";
    const sentinel = { node: "/usr/bin/node", script: "/usr/lib/node_modules/eacbot/cli.js", dataDir: "/Users/eacbot/.eacbot", home: "/Users/eacbot", out };
    expect(sentinelCommand(sentinel)).toEqual(["/usr/bin/node", "/usr/lib/node_modules/eacbot/cli.js", "sentinel", "--once", "--data-dir", "/Users/eacbot/.eacbot", "--out", out]);
    expect(sentinelCommand({ ...sentinel, script: "/srv/EACbot/server/eacbot.ts" })[1]).toBe("--experimental-strip-types");
    const plist = sentinelLaunchdPlist(sentinel);
    expect(plist).toContain("<string>com.eacbot.sentinel</string>");
    expect(plist).toContain("<key>StartInterval</key>\n\t<integer>120</integer>");
    expect(plist).toContain("<string>sentinel</string>");
    expect(plist).not.toContain("KeepAlive");
    expect(plist).toContain(`<string>${out}/sentinel.log</string>`);
    expect(plist).not.toContain(".eacbot/logs");
    const mac = sentinelServicePlan("darwin", out, "/Users/eacbot");
    expect(mac?.files).toEqual([{ name: "com.eacbot.sentinel.plist", installed: "/Users/eacbot/Library/LaunchAgents/com.eacbot.sentinel.plist" }]);
    // a path with a space is one argument in the printed commands
    expect(mac?.activate[0]).toBe("mkdir -p /Users/eacbot/Library/LaunchAgents && cp '/Users/eacbot/Library/Application Support/eacbot-sentinel/com.eacbot.sentinel.plist' /Users/eacbot/Library/LaunchAgents/com.eacbot.sentinel.plist");
    expect(mac?.deactivate[0]).toBe("launchctl bootout gui/$(id -u)/com.eacbot.sentinel");
  });

  it("renders Sentinel as a systemd user timer, with no root", () => {
    const sentinel = { node: "/usr/bin/node", script: "/usr/lib/node_modules/eacbot/cli.js", dataDir: "/home/eacbot/My Data", home: "/home/eacbot", out: "/home/eacbot/.local/state/eacbot-sentinel" };
    const unit = sentinelSystemdService(sentinel);
    expect(unit).toContain("Type=oneshot");
    expect(unit).toContain('ExecStart=/usr/bin/node /usr/lib/node_modules/eacbot/cli.js sentinel --once --data-dir "/home/eacbot/My Data" --out /home/eacbot/.local/state/eacbot-sentinel');
    expect(unit).not.toContain("User=");
    expect(sentinelSystemdTimer()).toContain("OnUnitActiveSec=120s");
    expect(sentinelSystemdTimer()).toContain("WantedBy=timers.target");
    const linux = sentinelServicePlan("linux", sentinel.out, "/home/eacbot");
    expect(linux?.files.map((file) => file.installed)).toEqual(["/home/eacbot/.config/systemd/user/eacbot-sentinel.service", "/home/eacbot/.config/systemd/user/eacbot-sentinel.timer"]);
    expect(linux?.activate[0]).toContain("cp /home/eacbot/.local/state/eacbot-sentinel/eacbot-sentinel.service");
    expect(linux?.activate.join("\n")).toContain("systemctl --user enable --now eacbot-sentinel.timer");
    expect(linux?.activate.join("\n")).not.toContain("sudo");
    expect(sentinelServicePlan("win32", "C:\\x")).toBeNull();
  });

  it("finds the CLI the installed desktop app ships, and runs it as Node", () => {
    const app = "/Applications/EACbot.app/Contents";
    const present = new Set([`${app}/MacOS/EACbot`, `${app}/Resources/server/eacbot.js`]);
    expect(shippedSentinelCli("darwin", "/Users/eacbot", (path) => present.has(path))).toEqual({ node: `${app}/MacOS/EACbot`, script: `${app}/Resources/server/eacbot.js` });
    const user = "/Users/eacbot/Applications/EACbot.app/Contents";
    expect(shippedSentinelCli("darwin", "/Users/eacbot", (path) => path.startsWith(user))?.script).toBe(`${user}/Resources/server/eacbot.js`);
    expect(shippedSentinelCli("linux", "/home/eacbot", (path) => path.startsWith("/opt/EACbot/"))).toEqual({ node: "/opt/EACbot/eacbot", script: "/opt/EACbot/resources/server/eacbot.js" });
    // an app with its script missing, or one released before Sentinel, is no CLI for it
    expect(shippedSentinelCli("darwin", "/Users/eacbot", (path) => path.endsWith("MacOS/EACbot"))).toBeNull();
    expect(shippedSentinelCli("darwin", "/Users/eacbot", (path) => present.has(path), () => false)).toBeNull();
    expect(shippedSentinelCli("win32", "C:\\Users\\eacbot", () => true)).toBeNull();

    const spec = { node: `${app}/MacOS/EACbot`, script: `${app}/Resources/server/eacbot.js`, dataDir: "/Users/eacbot/.eacbot", home: "/Users/eacbot", out: "/tmp/s", electronRunAsNode: true };
    expect(sentinelLaunchdPlist(spec)).toContain("<key>ELECTRON_RUN_AS_NODE</key>\n\t\t<string>1</string>");
    expect(sentinelSystemdService(spec)).toContain("Environment=ELECTRON_RUN_AS_NODE=1");
    expect(sentinelLaunchdPlist({ ...spec, electronRunAsNode: false })).not.toContain("ELECTRON_RUN_AS_NODE");
  });

  it("keeps every path one quoted value in the systemd unit, and refuses one no unit can hold", () => {
    const spec = { node: "/usr/bin/node", script: "/srv/omb/cli.js", dataDir: "/home/eacbot/100% $HOME\\", home: "/home/my eacbot", out: "/home/my eacbot/.local/state/eacbot-sentinel" };
    const unit = sentinelSystemdService(spec);
    expect(unit).toContain('Environment="HOME=/home/my eacbot"');
    // % is no specifier, $ no variable, and the trailing backslash no continuation
    expect(unit).toContain('"/home/eacbot/100%% $$HOME\\\\"');
    expect(sentinelUnitCommand(unit)).toEqual({ node: "/usr/bin/node", script: "/srv/omb/cli.js" });
    expect(sentinelUnitCommand(sentinelSystemdService({ ...spec, script: "/srv/100% $x/cli.js" }))?.script).toBe("/srv/100% $x/cli.js");
    for (const bad of ["/home/eacbot\n[Service]\nExecStartPre=/bin/true", "/home/eacbot\r", "/home/\0eacbot"]) {
      expect(() => sentinelSystemdService({ ...spec, home: bad })).toThrow(/line break or NUL/);
      expect(() => sentinelLaunchdPlist({ ...spec, dataDir: bad })).toThrow(/line break or NUL/);
    }
  });

  it("reads back what an installed unit runs, and calls it stale when either path is gone", () => {
    const spec = { node: "/opt/node & co/bin/node", script: "/srv/omb/cli.js", dataDir: "/home/eacbot/My Data", home: "/home/eacbot", out: "/home/eacbot/.local/state/eacbot-sentinel" };
    expect(sentinelUnitCommand(sentinelLaunchdPlist(spec))).toEqual({ node: "/opt/node & co/bin/node", script: "/srv/omb/cli.js" });
    expect(sentinelUnitCommand(sentinelSystemdService(spec))).toEqual({ node: "/opt/node & co/bin/node", script: "/srv/omb/cli.js" });
    expect(sentinelUnitCommand("[Service]\nType=oneshot\n")).toBeNull();

    const unit = "/home/eacbot/.config/systemd/user/eacbot-sentinel.service";
    const timer = "/home/eacbot/.config/systemd/user/eacbot-sentinel.timer";
    const files = new Map([[unit, sentinelSystemdService(spec)]]);
    const fs = (present: string[]) => ({ exists: (path: string) => files.has(path) || present.includes(path), read: (path: string) => files.get(path)! });
    expect(checkSentinelInstall("linux", "/home/eacbot", fs([spec.node, spec.script, timer]))).toMatchObject({ status: "ok", unit });
    expect(checkSentinelInstall("linux", "/home/eacbot", fs([spec.node, timer]))).toMatchObject({ status: "stale", missing: ["/srv/omb/cli.js"] });
    // the service without its timer never runs
    expect(checkSentinelInstall("linux", "/home/eacbot", fs([spec.node, spec.script]))).toMatchObject({ status: "stale", missing: [timer] });
    expect(checkSentinelInstall("darwin", "/Users/eacbot", fs([]))).toEqual({ status: "not_installed", unit: "/Users/eacbot/Library/LaunchAgents/com.eacbot.sentinel.plist" });
    files.set(unit, "garbage");
    expect(checkSentinelInstall("linux", "/home/eacbot", fs([]))).toEqual({ status: "unreadable", unit });
    expect(checkSentinelInstall("win32", "C:\\Users\\eacbot", fs([]))).toEqual({ status: "unsupported" });
  });
});
