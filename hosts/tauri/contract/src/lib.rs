//! Pure logic behind the EACbot Tauri host, kept free of tauri/OS dependencies so `cargo test` runs anywhere:
//! the `window.__EAC_HOST__` bootstrap the page contract requires, the `open_external` URL gate, the invoke
//! allowlist, and the service restart backoff.

use std::sync::LazyLock;

use serde_json::{json, Value};

/// The features the Tauri host implements. Anything not listed stays unsupported in the page.
pub static FEATURES: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "openExternal": "available",
        "chooseFolder": "available",
        "secureStorage": "available",
        "tray": "available",
    })
});

/// Which commands each feature's invoke may carry; anything else is refused before it reaches the OS.
pub static COMMANDS: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "secureStorage": ["secret_get", "secret_set"],
    })
});

/// The bootstrap injected into every window before page scripts run (see hosts/tauri/README.md).
pub fn host_bootstrap_script() -> String {
    let template = r#"(function () {
'use strict';
var features = %FEATURES%;
var commands = %COMMANDS%;
var allowed = function (feature, command) {
  var list = commands[feature];
  return Array.isArray(list) && list.indexOf(command) !== -1;
};
window.__EAC_HOST__ = {
  apiVersion: 1,
  kind: 'tauri',
  features: features,
  invoke: function (feature, command, args) {
    if (!allowed(feature, command)) {
      return Promise.reject(new Error('this EACbot host does not allow ' + feature + '/' + command));
    }
    return window.__TAURI_INTERNALS__.invoke('eac_' + feature + '_' + command, { args: args ?? null });
  },
  openExternal: function (url) {
    return window.__TAURI_INTERNALS__.invoke('eac_open_external', { url: String(url) });
  },
  chooseFolder: function () {
    return window.__TAURI_INTERNALS__.invoke('eac_choose_folder', {});
  }
};
})();
"#;
    template.replace("%FEATURES%", &FEATURES.to_string()).replace("%COMMANDS%", &COMMANDS.to_string())
}

/// `open_external` opens http(s) web addresses only: `file:` and any local path stay shut (README security note).
pub fn external_url_allowed(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.len() > 2_048 || trimmed.contains('\\') || trimmed.contains('<') || trimmed.contains('"') {
        return false;
    }
    let (scheme, rest) = match trimmed.split_once("://") {
        Some(parts) => parts,
        None => return false,
    };
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return false;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or("");
    let host = host.split(':').next().unwrap_or("");
    !host.is_empty() && host != "localhost" && !host.starts_with("127.") && !host.starts_with("192.168.") && !host.ends_with(".local")
}

/// The page's `invoke(feature, command, args)`: true only for commands this build actually implements.
pub fn invoke_allowed(feature: &str, command: &str) -> bool {
    let Some(list) = COMMANDS.get(feature).and_then(Value::as_array) else {
        return false;
    };
    list.iter().any(|entry| entry.as_str() == Some(command))
}/// Restart backoff for the Node service: 1 s, 2 s, 4 s, 8 s, then the cap; `None` says give up.
pub fn restart_delay_ms(restarts: u32) -> Option<u64> {
    const MAX_RESTARTS: u32 = 5;
    const CAP_MS: u64 = 10_000;
    if restarts >= MAX_RESTARTS {
        return None;
    }
    Some(CAP_MS.min(1_000u64 << restarts))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_script_installs_the_contract_once_and_whitelists() {
        let script = host_bootstrap_script();
        assert!(script.contains("window.__EAC_HOST__"));
        assert!(script.contains("apiVersion: 1"));
        assert!(script.contains("kind: 'tauri'"));
        assert!(script.contains("eac_' + feature + '_' + command"));
        assert!(!script.contains("eac_clipboard_read"));
        assert!(script.contains("eac_open_external"));
        assert!(script.contains("eac_choose_folder"));
    }

    #[test]
    fn open_external_takes_web_urls_only() {
        assert!(external_url_allowed("https://github.com/EACbot"));
        assert!(external_url_allowed("http://example.com/a?b=c#d"));
        assert!(!external_url_allowed("file:///C:/Windows/System32"));
        assert!(!external_url_allowed("C:\\Users\\victim\\secret"));
        assert!(!external_url_allowed("https://127.0.0.1:8799/pair"));
        assert!(!external_url_allowed("https://localhost/admin"));
        assert!(!external_url_allowed("javascript:alert(1)"));
        assert!(!external_url_allowed("https://"));
        assert!(!external_url_allowed(""));
    }

    #[test]
    fn invoke_allowlist_follows_the_contract_map() {
        assert!(invoke_allowed("secureStorage", "secret_get"));
        assert!(invoke_allowed("secureStorage", "secret_set"));
        assert!(!invoke_allowed("secureStorage", "secret_delete"));
        assert!(!invoke_allowed("shell", "exec"));
        assert!(!invoke_allowed("tray", "anything"));
    }

    #[test]
    fn restart_backoff_grows_then_gives_up() {
        assert_eq!(restart_delay_ms(0), Some(1_000));
        assert_eq!(restart_delay_ms(1), Some(2_000));
        assert_eq!(restart_delay_ms(3), Some(8_000));
        assert_eq!(restart_delay_ms(4), Some(10_000));
        assert_eq!(restart_delay_ms(5), None);
        assert_eq!(restart_delay_ms(9), None);
    }
}
