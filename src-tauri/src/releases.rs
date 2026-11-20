//! Public release notes for the installed version, with an offline cache.
use serde::{Deserialize, Serialize};
use std::{io::Read, path::Path, time::Duration};
use tauri::Manager;

const MAX_NOTES_BYTES: usize = 64 * 1024;
#[derive(Clone, Deserialize, Serialize)]
pub struct ReleaseNotes {
    version: String,
    title: String,
    body: String,
}
#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    name: Option<String>,
    body: Option<String>,
    draft: bool,
}
fn parse_release(bytes: &[u8], version: &str) -> Option<ReleaseNotes> {
    if bytes.len() > MAX_NOTES_BYTES {
        return None;
    }
    let release: GithubRelease = serde_json::from_slice(bytes).ok()?;
    if release.draft || release.tag_name != format!("v{version}") {
        return None;
    }
    let body = release.body?.trim().to_string();
    if body.is_empty() || body == "Draft release. Review and edit these notes before publishing." {
        return None;
    }
    Some(ReleaseNotes {
        version: version.into(),
        title: release
            .name
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| format!("OpenBeacon {version}")),
        body,
    })
}
fn cached_notes(path: &Path, version: &str) -> Option<ReleaseNotes> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() > MAX_NOTES_BYTES {
        return None;
    }
    let notes: ReleaseNotes = serde_json::from_slice(&bytes).ok()?;
    (notes.version == version && !notes.body.trim().is_empty()).then_some(notes)
}
fn fetch_notes(app: &tauri::AppHandle) -> Option<ReleaseNotes> {
    let version = env!("CARGO_PKG_VERSION");
    let cache = app
        .path()
        .app_cache_dir()
        .ok()
        .map(|dir| dir.join(format!("release-notes-{version}.json")));
    let downloaded = (|| -> Option<ReleaseNotes> {
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(5))
            .user_agent(format!("OpenBeacon/{version}"))
            .build()
            .ok()?;
        let response = client
            .get(format!(
                "https://api.github.com/repos/sideout909/OpenBeacon/releases/tags/v{version}"
            ))
            .header("Accept", "application/vnd.github+json")
            .send()
            .ok()?
            .error_for_status()
            .ok()?;
        let mut bytes = Vec::new();
        response
            .take((MAX_NOTES_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .ok()?;
        parse_release(&bytes, version)
    })();
    if let Some(notes) = downloaded {
        if let Some(path) = cache {
            if let Some(parent) = path.parent() {
                if std::fs::create_dir_all(parent).is_ok() {
                    if let Ok(bytes) = serde_json::to_vec(&notes) {
                        let _ = std::fs::write(path, bytes);
                    }
                }
            }
        }
        Some(notes)
    } else {
        cache.and_then(|path| cached_notes(&path, version))
    }
}
#[tauri::command]
pub async fn release_notes(app: tauri::AppHandle) -> Result<Option<ReleaseNotes>, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_notes(&app))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn release_notes_must_belong_to_the_installed_published_version() {
        let good = br###"{"tag_name":"v0.2.6","name":"OpenBeacon 0.2.6","body":"## Changes\n- Weather setup","draft":false}"###;
        let notes = parse_release(good, "0.2.6").unwrap();
        assert_eq!(notes.version, "0.2.6");
        assert!(notes.body.contains("Weather setup"));
        assert!(parse_release(good, "0.2.5").is_none());
        let draft = String::from_utf8(good.to_vec())
            .unwrap()
            .replace("false", "true");
        assert!(parse_release(draft.as_bytes(), "0.2.6").is_none());
        assert!(parse_release(&vec![b'x'; MAX_NOTES_BYTES + 1], "0.2.6").is_none());
        assert!(parse_release(b"invalid response", "0.2.6").is_none());
    }
    #[test]
    fn cache_cannot_substitute_notes_for_a_different_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.json");
        let notes = ReleaseNotes {
            version: "0.2.5".into(),
            title: "OpenBeacon".into(),
            body: "Changes".into(),
        };
        std::fs::write(&path, serde_json::to_vec(&notes).unwrap()).unwrap();
        assert!(cached_notes(&path, "0.2.5").is_some());
        assert!(cached_notes(&path, "0.2.6").is_none());
    }
    #[test]
    fn missing_or_placeholder_notes_use_bundled_highlights() {
        for body in [
            serde_json::Value::Null,
            serde_json::json!("   "),
            serde_json::json!("Draft release. Review and edit these notes before publishing."),
        ] {
            let release = serde_json::json!({
                "tag_name": "v0.2.6", "name": null, "body": body, "draft": false
            });
            assert!(parse_release(&serde_json::to_vec(&release).unwrap(), "0.2.6").is_none());
        }
        let release = serde_json::json!({
            "tag_name": "v0.2.6", "name": " ", "body": "Changes", "draft": false
        });
        let notes = parse_release(&serde_json::to_vec(&release).unwrap(), "0.2.6").unwrap();
        assert_eq!(notes.title, "OpenBeacon 0.2.6");
    }
}
