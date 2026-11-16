//! TVBox-compatible source requests. All remote fetches go through the app's
//! existing DNS, proxy and SSRF policy; this is intentionally not a general proxy.
use std::time::Duration;

const MAX_SOURCE_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const SOURCE_TIMEOUT: Duration = Duration::from_secs(25);

fn validate_source_url(raw: &str) -> Result<(), String> {
    if raw.len() > 4096 {
        return Err("源地址过长".into());
    }
    let parsed = url::Url::parse(raw.trim()).map_err(|_| "源地址不是有效 URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("源地址必须是无账号信息的 HTTP(S) URL".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn tvbox_fetch(url: String) -> Result<String, String> {
    validate_source_url(&url)?;
    let mut response = crate::net::get(
        url.trim(),
        SOURCE_TIMEOUT,
        Some("application/json, application/xml, text/xml, text/plain, text/html, */*"),
        None,
    )
    .await?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("源站返回 HTTP {}", status.as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_SOURCE_RESPONSE_BYTES as u64)
    {
        return Err("源响应超过 8 MiB 限制".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| crate::net::err_text(&error))?
    {
        if body.len().saturating_add(chunk.len()) > MAX_SOURCE_RESPONSE_BYTES {
            return Err("源响应超过 8 MiB 限制".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

#[cfg(test)]
mod tests {
    use super::validate_source_url;

    #[test]
    fn source_url_accepts_http_and_https() {
        assert!(validate_source_url("https://example.com/api.php").is_ok());
        assert!(validate_source_url("http://example.org:8080/vod").is_ok());
    }

    #[test]
    fn source_url_rejects_credentials_and_non_http_schemes() {
        assert!(validate_source_url("file:///tmp/config.json").is_err());
        assert!(validate_source_url("https://user:pass@example.com/api").is_err());
        assert!(validate_source_url("javascript:alert(1)").is_err());
    }
}
