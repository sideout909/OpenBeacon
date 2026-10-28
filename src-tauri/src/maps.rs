//! Read bounded ranges from the two application-provided PMTiles archives.
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};
use tauri::Manager;

const MAX_RANGE: usize = 8 * 1024 * 1024;

fn read_range(path: &Path, offset: u64, length: usize) -> Result<Vec<u8>, String> {
    if length == 0 || length > MAX_RANGE {
        return Err("Invalid map range length".into());
    }
    let mut file = File::open(path).map_err(|e| format!("Could not open map pack: {e}"))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("Could not seek map pack: {e}"))?;
    let mut bytes = vec![0; length];
    let mut total = 0;
    while total < length {
        let count = file
            .read(&mut bytes[total..])
            .map_err(|e| format!("Could not read map pack: {e}"))?;
        if count == 0 {
            break;
        }
        total += count;
    }
    bytes.truncate(total);
    Ok(bytes)
}

#[tauri::command]
pub async fn read_map_range(
    app: tauri::AppHandle,
    name: String,
    offset: u64,
    length: usize,
) -> Result<Vec<u8>, String> {
    if !matches!(
        name.as_str(),
        "world-z6.pmtiles" | "michigan-lower-z12.pmtiles"
    ) {
        return Err("Unknown bundled map pack".into());
    }
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    let path = resources.join("maps").join(&name);
    #[cfg(debug_assertions)]
    let path = if path.exists() {
        path
    } else {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../public/maps")
            .join(&name)
    };
    read_range(&path, offset, length)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    #[test]
    fn compressed_extractor_stages_and_runs_without_locking_source() {
        let dir = tempfile::tempdir().unwrap();
        let source =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/pmtiles-linux-x86_64.gz");
        let staged = stage_extractor(&source, dir.path()).unwrap();
        let output = std::process::Command::new(&staged)
            .arg("version")
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains("1.31.2"));
        assert!(source.is_file());
    }

    #[test]
    fn range_reads_are_bounded_and_truncated_at_end() {
        let path = std::env::temp_dir().join(format!("openbeacon-map-test-{}", std::process::id()));
        std::fs::write(&path, b"0123456789").unwrap();
        assert_eq!(read_range(&path, 3, 4).unwrap(), b"3456");
        assert_eq!(read_range(&path, 8, 4).unwrap(), b"89");
        assert!(read_range(&path, 0, MAX_RANGE + 1).is_err());
        std::fs::remove_file(path).unwrap();
    }
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn stage_extractor(source: &Path, directory: &Path) -> Result<tempfile::TempPath, String> {
    use std::os::unix::fs::PermissionsExt;
    let input = File::open(source).map_err(|e| format!("Map downloader unavailable: {e}"))?;
    let mut decoder = flate2::read::GzDecoder::new(input).take(64 * 1024 * 1024 + 1);
    let mut staged = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    let bytes = std::io::copy(&mut decoder, &mut staged)
        .map_err(|e| format!("Could not unpack map downloader: {e}"))?;
    if bytes == 0 || bytes > 64 * 1024 * 1024 {
        return Err("Bundled map downloader has an invalid size.".into());
    }
    std::fs::set_permissions(staged.path(), std::fs::Permissions::from_mode(0o700))
        .map_err(|e| e.to_string())?;
    Ok(staged.into_temp_path())
}

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::{Emitter, State};

#[derive(Default)]
pub struct MapDownload {
    running: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
}

#[tauri::command]
pub fn cancel_map_download(state: State<'_, MapDownload>) {
    state.cancel.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub async fn read_downloaded_map(
    app: tauri::AppHandle,
    offset: u64,
    length: usize,
) -> Result<Vec<u8>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    read_range(&dir.join("maps/region.pmtiles"), offset, length)
}

#[tauri::command]
pub async fn download_region_map(
    app: tauri::AppHandle,
    state: State<'_, MapDownload>,
    geometry: serde_json::Value,
    zoom: u8,
) -> Result<(), String> {
    if !(8..=15).contains(&zoom) {
        return Err("Choose a map detail level from 8 to 15.".into());
    }
    if !matches!(
        geometry.get("type").and_then(|v| v.as_str()),
        Some("Polygon" | "MultiPolygon")
    ) || geometry.to_string().len() > 2_000_000
    {
        return Err("Invalid region boundary.".into());
    }
    if state
        .running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("A map download is already running.".into());
    }
    state.cancel.store(false, Ordering::SeqCst);
    let running = state.running.clone();
    let cancel = state.cancel.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let result = (|| -> Result<(), String> {
            #[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
            return Err("Map downloading is currently available on Linux x86-64 only.".into());
            #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
            {
                use std::os::unix::process::CommandExt;
                let dir = app
                    .path()
                    .app_data_dir()
                    .map_err(|e| e.to_string())?
                    .join("maps");
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                let region = tempfile::NamedTempFile::new_in(&dir).map_err(|e| e.to_string())?;
                std::fs::write(
                    region.path(),
                    serde_json::to_vec(&geometry).map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;
                let output = tempfile::NamedTempFile::new_in(&dir).map_err(|e| e.to_string())?;
                let binary = app
                    .path()
                    .resource_dir()
                    .map_err(|e| e.to_string())?
                    .join("pmtiles-linux-x86_64.gz");
                let dev =
                    Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/pmtiles-linux-x86_64.gz");
                let binary = if binary.is_file() { binary } else { dev };
                let staged_path = stage_extractor(&binary, &dir)?;
                let output_path = output.path().to_owned();
                let mut command = std::process::Command::new(&staged_path);
                command
                    .arg("extract")
                    .arg("https://data.source.coop/protomaps/openstreetmap/v4.pmtiles")
                    .arg(&output_path)
                    .arg(format!("--region={}", region.path().display()))
                    .arg(format!("--maxzoom={zoom}"))
                    .arg("--download-threads=2")
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null());
                let parent = std::process::id();
                unsafe {
                    command.pre_exec(move || {
                        if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                            return Err(std::io::Error::last_os_error());
                        }
                        if libc::getppid() as u32 != parent {
                            return Err(std::io::Error::other(
                                "OpenBeacon exited during map download startup",
                            ));
                        }
                        Ok(())
                    });
                }
                let mut child = command
                    .spawn()
                    .map_err(|e| format!("Could not start map downloader: {e}"))?;
                drop(staged_path);
                loop {
                    if cancel.load(Ordering::SeqCst) {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err("Map download canceled.".into());
                    }
                    match child.try_wait().map_err(|e| e.to_string())? {
                        Some(status) if status.success() => break,
                        Some(status) => {
                            return Err(format!(
                            "Map download failed ({status}). Check your connection and try again."
                        ))
                        }
                        None => {
                            let bytes = std::fs::metadata(&output_path)
                                .map(|m| m.len())
                                .unwrap_or(0);
                            let _ = app.emit("map-download-progress", bytes);
                            std::thread::sleep(Duration::from_millis(300));
                        }
                    }
                }
                if cancel.load(Ordering::SeqCst) {
                    return Err("Map download canceled.".into());
                }
                let header = read_range(&output_path, 0, 127)?;
                if header.len() != 127 || &header[..7] != b"PMTiles" {
                    return Err("Downloaded map is invalid.".into());
                }
                output
                    .persist(dir.join("region.pmtiles"))
                    .map_err(|e| format!("Could not save map: {e}"))?;
                Ok(())
            }
        })();
        running.store(false, Ordering::SeqCst);
        result
    })
    .await
    .map_err(|e| e.to_string())?;
    result
}
