//! 应用内代理设置：跟随系统 / 自定义 / 直连。
//!
//! 客户端的全部流量都走 Rust 侧的 reqwest（见 `net.rs` 顶部说明），它既不与
//! WebView 共享代理设置，也读不到 Android 的系统「Wi-Fi 代理」。此前只有
//! `HGHUB_PROXY` 环境变量与桌面系统代理两条路，移动端用户只能靠 VPN/TUN 接管。
//!
//! 这里把代理做成一等配置：用户显式给一条 `http(s)://` 或 `socks5://` 地址，
//! 三个平台行为一致；`off` 模式则强制直连（覆盖系统代理与环境变量），用来排除
//! 「代理软件已关闭、reqwest 仍往旧端口建隧道」这类问题。
//!
//! 配置落盘在应用数据目录的 `proxy.json`，由 [`bind`] 在启动时读取。

use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::RwLock;

/// 允许的代理协议。`socks5h` / `socks4a` 表示域名交给代理解析（reqwest 同样支持）。
const SCHEMES: [&str; 6] = ["http", "https", "socks5", "socks5h", "socks4", "socks4a"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// 沿用操作系统 / 环境变量里的代理（默认行为）
    System,
    /// 用户指定的一条代理，优先级高于系统代理与环境变量
    Custom,
    /// 强制直连，忽略系统代理与环境变量
    Off,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::System => "system",
            Mode::Custom => "custom",
            Mode::Off => "off",
        }
    }

    fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "" | "system" | "auto" => Some(Mode::System),
            "custom" | "manual" | "http" | "socks" => Some(Mode::Custom),
            "off" | "none" | "direct" => Some(Mode::Off),
            _ => None,
        }
    }
}

struct Config {
    mode: Mode,
    /// 自定义代理地址。非 `Custom` 模式也保留，方便用户再次启用时不用重填。
    url: String,
}

static CONFIG: Lazy<RwLock<Config>> = Lazy::new(|| {
    RwLock::new(Config {
        mode: Mode::System,
        url: String::new(),
    })
});
static FILE: Lazy<RwLock<Option<PathBuf>>> = Lazy::new(|| RwLock::new(None));

/// 当前代理模式。
pub fn mode() -> Mode {
    CONFIG.read().map(|c| c.mode).unwrap_or(Mode::System)
}

/// 自定义代理地址；仅 `Custom` 模式返回 `Some`（供 `net::detected_proxy` 用）。
pub fn custom_url() -> Option<String> {
    if mode() != Mode::Custom {
        return None;
    }
    CONFIG
        .read()
        .ok()
        .map(|c| c.url.clone())
        .filter(|u| !u.is_empty())
}

/// 界面上要回填的地址（任何模式都返回，方便切换模式时保留输入）。
pub fn stored_url() -> String {
    CONFIG.read().map(|c| c.url.clone()).unwrap_or_default()
}

/// 启动时读取 `proxy.json`；文件缺失、损坏或地址非法时退回「跟随系统」。
pub fn bind(dir: &Path) {
    let path = dir.join("proxy.json");
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            let mode = v
                .get("mode")
                .and_then(Value::as_str)
                .and_then(Mode::parse)
                .unwrap_or(Mode::System);
            // 自定义模式下地址必须仍然合法，否则宁可退回系统代理，也不要带着坏配置启动。
            let url = v.get("url").and_then(Value::as_str).unwrap_or_default();
            let normalized = normalize_proxy(url).ok().unwrap_or_default();
            let effective = match mode {
                Mode::Custom if normalized.is_empty() => Mode::System,
                other => other,
            };
            if let Ok(mut cfg) = CONFIG.write() {
                cfg.mode = effective;
                cfg.url = normalized;
            }
        }
    }
    if let Ok(mut f) = FILE.write() {
        *f = Some(path);
    }
}

/// 保存代理设置并立即生效（调用方负责 `net::refresh_client`）。
pub fn set(mode_raw: &str, url_raw: &str) -> Result<Value, String> {
    let mode = Mode::parse(mode_raw).ok_or("代理模式无效")?;
    let current = stored_url();
    let url = if mode == Mode::Custom {
        normalize_proxy(url_raw)?
    } else {
        // 非自定义模式：给了合法地址就顺手记住，没给就沿用上次的，便于来回切换。
        let trimmed = url_raw.trim();
        if trimmed.is_empty() {
            current
        } else {
            normalize_proxy(trimmed).unwrap_or(current)
        }
    };

    let path = FILE.read().ok().and_then(|p| p.clone());
    if let Some(path) = path {
        write_atomic(&path, &json!({ "mode": mode.as_str(), "url": url }).to_string())?;
    }
    if let Ok(mut cfg) = CONFIG.write() {
        cfg.mode = mode;
        cfg.url = url;
    }
    Ok(json!({ "mode": mode.as_str() }))
}

/// 代理地址归一化：允许省略协议（按 http 处理），只保留协议 / 认证 / 主机 / 端口。
///
/// 用户常见输入是 `127.0.0.1:7897`（Clash 默认端口），所以缺协议时补 `http://`；
/// 路径与查询串一律拒绝——代理地址不需要它们，放行只会让错误配置更难排查。
pub fn normalize_proxy(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("请填写代理地址（例：http://127.0.0.1:7897）".into());
    }
    if raw.chars().any(char::is_control) {
        return Err("代理地址含控制字符".into());
    }
    let with_scheme = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("http://{raw}")
    };
    let parsed = url::Url::parse(&with_scheme)
        .map_err(|_| "代理地址格式无效（例：http://127.0.0.1:7897）".to_string())?;
    if !SCHEMES.contains(&parsed.scheme()) {
        return Err("代理协议只支持 http / https / socks5 / socks4".into());
    }
    let host = parsed.host_str().ok_or("代理地址缺少主机名")?;
    // 非特殊协议（socks5 等）没有路径时 `path()` 返回空串，http(s) 则是 "/"。
    if !matches!(parsed.path(), "" | "/") || parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("代理地址不要带路径、参数或片段".into());
    }
    let host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    let port = parsed.port().map(|p| format!(":{p}")).unwrap_or_default();
    let auth = match (parsed.username(), parsed.password()) {
        ("", _) => String::new(),
        (user, Some(pass)) => format!("{user}:{pass}@"),
        (user, None) => format!("{user}@"),
    };
    Ok(format!("{}://{auth}{host}{port}", parsed.scheme()))
}

/// 先写临时文件再改名，避免掉电/崩溃留下半个 JSON。
fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, text)
        .and_then(|_| std::fs::rename(&temp, path))
        .map_err(|_| "无法保存代理设置，请检查应用数据目录".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// 配置是进程级单例，落盘测试必须串行，否则并行跑会互相覆盖 `FILE`。
    static LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn proxy_addresses_are_normalized() {
        assert_eq!(
            normalize_proxy("127.0.0.1:7897").unwrap(),
            "http://127.0.0.1:7897"
        );
        assert_eq!(
            normalize_proxy("  http://127.0.0.1:7897/  ").unwrap(),
            "http://127.0.0.1:7897"
        );
        assert_eq!(
            normalize_proxy("socks5://alice:secret@[::1]:1080").unwrap(),
            "socks5://alice:secret@[::1]:1080"
        );
        assert!(normalize_proxy("[::1]:1080").unwrap().starts_with("http://[::1]:1080"));
        for bad in [
            "",
            "http://127.0.0.1:7897/path",
            "http://127.0.0.1:7897?x=1",
            "http://user@:8080",
            "ftp://127.0.0.1:21",
            // 首尾空白会被 trim 掉（用户复制粘贴很常见），中间的换行必须拒绝
            "http://127.0.0.1:7897\n7897",
        ] {
            assert!(normalize_proxy(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn modes_round_trip_and_reject_unknown_values() {
        assert_eq!(Mode::parse("system"), Some(Mode::System));
        assert_eq!(Mode::parse(""), Some(Mode::System));
        assert_eq!(Mode::parse("custom"), Some(Mode::Custom));
        assert_eq!(Mode::parse("off"), Some(Mode::Off));
        assert_eq!(Mode::parse("bogus"), None);
        for mode in [Mode::System, Mode::Custom, Mode::Off] {
            assert_eq!(Mode::parse(mode.as_str()), Some(mode));
        }
    }

    #[test]
    fn saving_a_custom_proxy_persists_and_restores() {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("hghubx-proxy-{}-{unique}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        bind(&dir);
        assert_eq!(set("custom", "127.0.0.1:7897").unwrap()["mode"], "custom");
        assert_eq!(mode(), Mode::Custom);
        assert_eq!(custom_url().as_deref(), Some("http://127.0.0.1:7897"));

        // 切回系统代理：地址保留，但不再参与请求。
        set("system", "").unwrap();
        assert_eq!(mode(), Mode::System);
        assert_eq!(custom_url(), None);
        assert_eq!(stored_url(), "http://127.0.0.1:7897");

        // 重启后恢复自定义模式。
        set("custom", "http://127.0.0.1:7897").unwrap();
        *CONFIG.write().unwrap() = Config {
            mode: Mode::System,
            url: String::new(),
        };
        bind(&dir);
        assert_eq!(mode(), Mode::Custom);
        assert_eq!(custom_url().as_deref(), Some("http://127.0.0.1:7897"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn broken_config_falls_back_to_system_mode() {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "hghubx-proxy-broken-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(
            dir.join("proxy.json"),
            r#"{"mode":"custom","url":"ftp://nope"}"#,
        )
        .unwrap();
        bind(&dir);
        assert_eq!(mode(), Mode::System);
        assert_eq!(custom_url(), None);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
