//! The supervised local Node service: one instance, a free port, a readiness probe, restarts with a capped backoff,
//! and a clean stop when the shell exits. The shell owns the window and credentials; the service owns the Bot.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use eac_host_contract::restart_delay_ms;

pub struct ServiceHandle {
    server_dir: PathBuf,
    port: u16,
    child: Mutex<Option<Child>>,
    restarts: AtomicU32,
    started_at: Mutex<Option<Instant>>,
}

/// Picks a port the OS says is free; the service takes `--port` so it never guesses.
fn free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

impl ServiceHandle {
    /// `server_dir` is the checkout (or packaged resource) holding `server/eacbot.ts`; Node runs it with
    /// `--experimental-strip-types`, so no build step stands between the shell and the server.
    pub fn start(server_dir: PathBuf) -> Result<Self, String> {
        let port = free_port().map_err(|error| format!("no free port: {error}"))?;
        let handle = ServiceHandle {
            server_dir,
            port,
            child: Mutex::new(None),
            restarts: AtomicU32::new(0),
            started_at: Mutex::new(None),
        };
        handle.spawn_child().map_err(|error| format!("the EACbot service could not start: {error}"))?;
        handle.wait_ready(Duration::from_secs(20))?;
        Ok(handle)
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    fn node_executable() -> String {
        // Windows needs node.exe from PATH; ELECTRON_RUN_AS_NODE keeps a packaged Electron honest if one is on PATH.
        if cfg!(windows) { "node.exe".into() } else { "node".into() }
    }

    fn spawn_child(&self) -> std::io::Result<()> {
        let child = Command::new(Self::node_executable())
            .args([
                "--experimental-strip-types",
                "server/eacbot.ts",
                "serve",
                "--port",
                &self.port.to_string(),
                "--no-pair",
            ])
            .current_dir(&self.server_dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        *self.child.lock().expect("service child lock") = Some(child);
        *self.started_at.lock().expect("service start lock") = Some(Instant::now());
        Ok(())
    }

    /// A TCP accept is the readiness probe: the server binds after its routes exist, so a connect means navigate.
    fn wait_ready(&self, budget: Duration) -> Result<(), String> {
        let deadline = Instant::now() + budget;
        while Instant::now() < deadline {
            if self.probe_once() {
                return Ok(());
            }
            if self.exited_recently() {
                return Err("the EACbot service exited during startup".into());
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        Err("the EACbot service did not become ready in time".into())
    }

    fn probe_once(&self) -> bool {
        let mut stream = match TcpStream::connect(("127.0.0.1", self.port)) {
            Ok(stream) => stream,
            Err(_) => return false,
        };
        let request = format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n", self.port);
        if stream.write_all(request.as_bytes()).is_err() {
            return false;
        }
        let mut head = [0u8; 12];
        let ok = stream.read(&mut head).map(|read| read >= 12 && head.starts_with(b"HTTP/1.")).unwrap_or(false);
        ok
    }

    fn exited_recently(&self) -> bool {
        let mut child = self.child.lock().expect("service child lock");
        let Some(running) = child.as_mut() else {
            return true;
        };
        matches!(running.try_wait(), Ok(Some(_)))
    }

    /// Called from a watchdog thread: restarts a crashed service under the capped backoff, gives up past the cap.
    pub fn ensure_running(&self) -> Result<bool, String> {
        {
            let mut child = self.child.lock().expect("service child lock");
            if let Some(running) = child.as_mut() {
                if running.try_wait().map_err(|error| error.to_string())?.is_none() {
                    return Ok(false);
                }
            }
            *child = None;
        }
        let restarts = self.restarts.fetch_add(1, Ordering::SeqCst);
        let Some(delay) = restart_delay_ms(restarts) else {
            return Err(format!("the EACbot service exited {restarts} times; start it again from the tray"));
        };
        std::thread::sleep(Duration::from_millis(delay));
        self.spawn_child().map_err(|error| error.to_string())?;
        self.wait_ready(Duration::from_secs(20))?;
        Ok(true)
    }

    /// The shell is closing: the service dies with it, so nothing keeps serving after the window is gone.
    pub fn stop(&self) {
        let mut child = self.child.lock().expect("service child lock");
        if let Some(mut running) = child.take() {
            let _ = running.kill();
            let _ = running.wait();
        }
    }
}

impl Drop for ServiceHandle {
    fn drop(&mut self) {
        self.stop();
    }
}
