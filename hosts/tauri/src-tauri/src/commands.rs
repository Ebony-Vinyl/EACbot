//! The invoke commands the page contract names, each gated by the pure allowlist in eac-host-contract:
//! system credentials (secret_get/secret_set), external links and folder picking.

use std::sync::Mutex;

use eac_host_contract::{external_url_allowed, invoke_allowed};
use tauri::{AppHandle, State};

/// Command names reach Rust as `eac_<feature>_<command>`; the allowlist below is the single gate.
#[derive(Default)]
pub struct Secrets(Mutex<std::collections::HashMap<String, String>>);

fn keyring_service() -> String {
    "EACbot".to_string()
}

fn keyring_entry(key: &str) -> Result<keyring::Entry, String> {
    if !key.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.') || key.len() > 120 {
        return Err("the secret key has characters this keyring does not take".into());
    }
    keyring::Entry::new(&keyring_service(), key).map_err(|error| format!("the system credential store refused: {error}"))
}

#[tauri::command]
pub fn eac_secure_storage_secret_get(key: String, secrets: State<Secrets>) -> Result<String, String> {
    if !invoke_allowed("secureStorage", "secret_get") {
        return Err("this EACbot host does not allow secureStorage/secret_get".into());
    }
    if let Ok(held) = secrets.0.lock() {
        if let Some(value) = held.get(&key) {
            return Ok(value.clone());
        }
    }
    keyring_entry(&key)?.get_password().map_err(|error| format!("no secret {key}: {error}"))
}

#[tauri::command]
pub fn eac_secure_storage_secret_set(key: String, value: String, secrets: State<Secrets>) -> Result<(), String> {
    if !invoke_allowed("secureStorage", "secret_set") {
        return Err("this EACbot host does not allow secureStorage/secret_set".into());
    }
    if value.len() > 8_192 {
        return Err("the secret is too large for the system credential store".into());
    }
    keyring_entry(&key)?.set_password(&value).map_err(|error| format!("the system credential store refused: {error}"))?;
    if let Ok(mut held) = secrets.0.lock() {
        held.insert(key, value);
    }
    Ok(())
}

/// `open_external`: the pure gate first (web addresses only), then the OS opener.
#[tauri::command]
pub fn eac_open_external(app: AppHandle, url: String) -> Result<(), String> {
    if !external_url_allowed(&url) {
        return Err("only https or http web addresses can be opened externally".into());
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_url(url, None::<&str>).map_err(|error| format!("the link could not be opened: {error}"))
}

/// `choose_folder` hands the page a real directory via the native dialog, never a path typed in a text box.
#[tauri::command]
pub fn eac_choose_folder(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    Ok(app.dialog().file().blocking_pick_folder().map(|path| path.to_string()))
}

/// The supervised service's address, so the page can point itself at the local Bot.
#[tauri::command]
pub fn eac_service_url(service: State<'_, crate::service::ServiceHandle>) -> Result<String, String> {
    Ok(service.url())
}

/// Non-blocking health for the tray menu: restarts the service if it died, reports whether it is serving.
#[tauri::command]
pub fn eac_service_status(service: State<'_, crate::service::ServiceHandle>) -> Result<serde_json::Value, String> {
    let restarted = service.ensure_running()?;
    Ok(serde_json::json!({ "url": service.url(), "restarted": restarted }))
}
