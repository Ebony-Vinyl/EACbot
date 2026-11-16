import { fork } from "node:child_process";

/** Credentials arrive only from the child this desktop owns, never from a discovered port. */
export function createCoreService({ entry, dataDir, origin, execPath = process.execPath, source = false, spawn = fork }) {
  let child;
  let ready;
  let stopped = false;
  let key;
  let expiresAt = 0;
  function stop() {
    stopped = true;
    child?.kill();
    child = undefined;
    ready = undefined;
  }
  function connect(commandPath = process.env.PATH) {
    const directory = dataDir();
    const allowedOrigin = origin();
    const nextKey = JSON.stringify([directory, allowedOrigin]);
    if (key !== nextKey) { stop(); key = nextKey; }
    if (ready && expiresAt && expiresAt <= Date.now()) stop();
    if (ready) return ready;
    stopped = false;
    const proc = spawn(entry, [], {
      execPath,
      execArgv: source ? ["--experimental-strip-types"] : [],
      env: { ...process.env, PATH: commandPath, ELECTRON_RUN_AS_NODE: "1", EAC_CORE_DATA_DIR: directory, EAC_CORE_PORT: "0", EAC_CORE_HOST: "127.0.0.1", EAC_CORE_DESKTOP_ORIGIN: allowedOrigin, EAC_CORE_FAKE_AGENTS: "0" },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
    child = proc;
    ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { proc.kill(); reject(new Error("任务服务启动超时")); }, 30_000);
      proc.once("error", error => { clearTimeout(timer); if (child === proc) ready = undefined; reject(error); });
      proc.on("message", message => {
        if (message?.type !== "eac-core-ready") return;
        clearTimeout(timer);
        expiresAt = Date.parse(message.connection.session.expiresAt);
        resolve(message.connection);
      });
      proc.once("exit", () => {
        clearTimeout(timer);
        if (child === proc) { child = undefined; ready = undefined; }
        reject(new Error(stopped ? "任务服务已停止" : "任务服务已退出"));
      });
    });
    return ready;
  }
  return { connect, stop };
}
