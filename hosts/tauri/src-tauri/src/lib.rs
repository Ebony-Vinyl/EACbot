//! EACbot's Tauri shell: one window pointed at the supervised local service, a tray, the system credential store
//! and the page contract. The shell owns nothing about the Bot itself — the Node service does.

mod commands;
mod service;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use eac_host_contract::host_bootstrap_script;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

/// The server checkout that ships next to this shell (dev: the repo root; packaged: a bundled resource).
fn server_dir(app: &AppHandle) -> PathBuf {
    let packaged = app.path().resource_dir().ok().map(|dir| dir.join("server"));
    if packaged.as_ref().is_some_and(|dir| dir.join("server/eacbot.ts").is_file()) {
        return packaged.expect("resource dir");
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn navigate_to_service(app: &AppHandle, url: &str) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let parsed: tauri::Url = url.parse().expect("service url");
    let _ = window.navigate(parsed);
    let _ = window.show();
    let _ = window.set_focus();
}

fn spawn_watchdog(app: AppHandle, service: Arc<service::ServiceHandle>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(5));
        match service.ensure_running() {
            Ok(true) => navigate_to_service(&app, &service.url()),
            Ok(false) => {}
            Err(reason) => {
                let _ = app.emit("eac://service-down", reason);
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(commands::Secrets::default())
        .setup(|app| {
            let server = server_dir(app.handle());
            let started = service::ServiceHandle::start(server).map_err(std::io::Error::other)?;
            let service = Arc::new(started);
            app.manage(service.clone());

            let open = MenuItem::with_id(app, "open", "打开 EACbot", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::with_id("eacbot-tray")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            let handle = app.handle().clone();
            let service_for_window = service.clone();
            std::thread::spawn(move || {
                navigate_to_service(&handle, &service_for_window.url());
                spawn_watchdog(handle.clone(), service_for_window);
            });

            let bootstrap = host_bootstrap_script();
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval(&bootstrap);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::eac_secure_storage_secret_get,
            commands::eac_secure_storage_secret_set,
            commands::eac_open_external,
            commands::eac_choose_folder,
            commands::eac_service_url,
            commands::eac_service_status,
        ])
        .run(tauri::generate_context!())
        .expect("EACbot could not start");
}
