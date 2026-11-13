import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const MAX_OUTPUT = 1_000_000;

function spawnFor(cli, args, env) {
  if (process.platform === "win32" && /\.ps1$/i.test(cli)) {
    throw new Error("use lark-cli.exe or a .cmd wrapper; PowerShell .ps1 wrappers do not pass --flags reliably");
  }
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(cli)) {
    // The only free text is written to stdin; every argument is a validated id or a fixed flag.
    return spawn(cli, args, { env, windowsHide: true, shell: true, stdio: ["pipe", "pipe", "pipe"] });
  }
  return spawn(cli, args, { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
}

function environment(configDir) {
  const env = { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" };
  if (configDir) env.LARKSUITE_CLI_CONFIG_DIR = configDir;
  return env;
}

function killChild(child) {
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", () => { try { child.kill(); } catch {} });
    return;
  }
  try { child.kill(); } catch {}
}

function parsed(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

export function larkError(result) {
  if (!result) return "lark-cli returned no result";
  if (result.error) return result.error;
  const body = result.json;
  if (result.code !== 0) {
    const code = body?.error?.code ?? body?.code;
    const message = body?.error?.message ?? body?.msg ?? result.stderr ?? ("lark-cli exited with code " + result.code);
    return String(code === undefined ? message : code + ": " + message);
  }
  if (body?.ok === false) {
    const code = body.error?.code;
    const message = body.error?.message ?? body.error?.hint ?? "lark-cli refused the command";
    return String(code === undefined ? message : code + ": " + message);
  }
  if (body && typeof body.code === "number" && body.code !== 0) {
    return String(body.code + ": " + String(body.msg ?? "lark-cli refused the command"));
  }
  return null;
}

export function larkData(result) {
  const body = result?.json;
  if (!body) return null;
  return body.data ?? body;
}

export async function runLark(cli, args, options = {}) {
  let child;
  try {
    child = spawnFor(cli, args, environment(options.configDir));
  } catch (error) {
    return { code: null, stdout: "", stderr: "", json: null, error: error instanceof Error ? error.message : String(error) };
  }
  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => {
    killChild(child);
  }, options.timeoutMs ?? 30_000);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  try { child.stdin.end(typeof options.input === "string" ? options.input : ""); } catch {}
  child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-MAX_OUTPUT); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-MAX_OUTPUT); });
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    child.once("error", (error) => finish({ code: null, stdout, stderr, json: null, error: error.message }));
    child.once("close", (code, signal) => finish({
      code: code ?? 1,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      json: parsed(stdout),
      ...(signal ? { error: "lark-cli ended by signal " + signal } : {}),
    }));
  });
}

export async function checkStrictBot(cli, configDir) {
  const result = await runLark(cli, ["config", "strict-mode"], { configDir, timeoutMs: 10_000 });
  const error = larkError(result);
  if (error) return { ok: false, error };
  const output = String(result.stdout ?? "").trim();
  const match = /strict-mode:\s*(\w+)/i.exec(output);
  const mode = (match?.[1] ?? output.split(/\s+/).pop() ?? "").toLowerCase();
  if (mode !== "bot") return { ok: false, error: "lark-cli strict-mode is " + (mode || "unknown") + "; set it to bot" };
  return { ok: true };
}

export function consumeEvents(cli, configDir, handlers) {
  const child = spawnFor(cli, ["event", "consume", "im.message.receive_v1", "--as", "bot"], environment(configDir));
  const stdout = createInterface({ input: child.stdout });
  const stderr = createInterface({ input: child.stderr });
  let ready = false;
  const stop = () => {
    try { child.stdin.end(); } catch {}
    killChild(child);
  };
  stdout.on("line", (line) => {
    if (line.length > 1_048_576) {
      handlers.onError(new Error("Feishu event exceeds 1 MiB"));
      return;
    }
    let event;
    try { event = JSON.parse(line); } catch { handlers.onError(new Error("Feishu event is not JSON")); return; }
    handlers.onEvent(event);
  });
  stderr.on("line", (line) => {
    if (line.startsWith("[event] ready")) {
      ready = true;
      handlers.onReady();
    } else if (/WARN|drop|error|exited/i.test(line)) {
      handlers.onStderr(line.slice(0, 4_000));
    }
  });
  child.once("error", (error) => handlers.onError(error));
  child.once("close", (code, signal) => handlers.onClose({ code, signal, ready }));
  return { child, stop, isReady: () => ready };
}
