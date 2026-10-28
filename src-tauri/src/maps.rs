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

// go-pmtiles prints carriage-return-delimited progress updates to stdout.
fn extract_progress(line: &str) -> Option<u8> {
    let line = line
        .trim_start()
        .strip_prefix("fetching chunks")?
        .trim_start();
    let value = line
        .split_whitespace()
        .next()?
        .strip_suffix('%')?
        .parse::<u8>()
        .ok()?;
    (value <= 100).then_some(value)
}

fn read_extract_progress(
    mut reader: impl Read,
    mut update: impl FnMut(u8),
) -> std::io::Result<Option<String>> {
    let mut frame = Vec::new();
    let mut discard = false;
    let mut last = None;
    let mut error_line = None;
    let mut last_message = None;
    let mut bytes = [0u8; 4096];
    loop {
        let n = reader.read(&mut bytes)?;
        if n == 0 {
            break;
        }
        for &b in &bytes[..n] {
            if b == b'\r' || b == b'\n' {
                if !discard {
                    if let Ok(text) = std::str::from_utf8(&frame) {
                        if let Some(percent) = extract_progress(text) {
                            // The archive still needs to be finalized and checked at 100%.
                            let percent = percent.min(99);
                            if last.is_none_or(|previous| percent > previous) {
                                update(percent);
                                last = Some(percent);
                            }
                        } else if !text.trim().is_empty() {
                            let message: String = text.trim().chars().take(700).collect();
                            if text.to_ascii_lowercase().contains("failed to extract") {
                                error_line = Some(message.clone());
                            }
                            last_message = Some(message);
                        }
                    }
                }
                frame.clear();
                discard = false;
            } else if !discard && frame.len() < 8192 {
                frame.push(b);
            } else {
                discard = true;
            }
        }
    }
    if !discard && !frame.is_empty() {
        let message = String::from_utf8_lossy(&frame).trim().to_owned();
        if !message.is_empty() && extract_progress(&message).is_none() {
            if message.to_ascii_lowercase().contains("failed to extract") {
                error_line = Some(message.chars().take(700).collect());
            } else {
                last_message = Some(message.chars().take(700).collect());
            }
        }
    }
    Ok(error_line.or(last_message))
}

fn read_error_tail(mut reader: impl Read) -> std::io::Result<String> {
    let mut tail = std::collections::VecDeque::new();
    let mut chunk = [0u8; 2048];
    loop {
        let n = reader.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        for &byte in &chunk[..n] {
            if tail.len() == 8192 {
                tail.pop_front();
            }
            tail.push_back(byte);
        }
    }
    let bytes: Vec<u8> = tail.into_iter().collect();
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn download_failure(status: impl std::fmt::Display, stderr: &str) -> String {
    let message = stderr.lines().map(str::trim).rfind(|line| !line.is_empty());
    match message {
        Some(line) => format!(
            "Map download failed ({status}): {}",
            line.chars().take(700).collect::<String>()
        ),
        None => format!("Map download failed ({status}). The downloader did not report a reason. Check available disk space and try a smaller area."),
    }
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
    fn extractor_progress_reads_real_carriage_return_output() {
        let data = b"2026/10/28 extracting\n\rfetching chunks   0% | | (0 B/1.2 MB)\r\rfetching chunks  25% | | (300 kB/1.2 MB)\r\rfetching chunks 100% | | (1.2/1.2 MB)\n";
        let mut seen = Vec::new();
        read_extract_progress(&data[..], |value| seen.push(value)).unwrap();
        assert_eq!(seen, [0, 25, 99]);
        assert_eq!(extract_progress("other 50% |"), None);
        assert_eq!(extract_progress("fetching chunks 101% |"), None);
    }

    #[test]
    fn progress_ignores_preallocated_file_size_and_recovers_after_garbage() {
        let mut input = vec![b'x'; 9000];
        input.extend_from_slice(
            b"\rfetching chunks  12% |\r\nfetching chunks  10% |\r\nfetching chunks  40% |\r",
        );
        let mut seen = Vec::new();
        read_extract_progress(&input[..], |value| seen.push(value)).unwrap();
        assert_eq!(seen, [12, 40]);
    }

    #[test]
    fn extractor_failure_reported_on_stdout_is_preserved() {
        let output = b"2026/10/28 main.go:185: Failed to extract, server returned HTTP 503\n";
        let error = read_extract_progress(&output[..], |_| {}).unwrap().unwrap();
        assert!(download_failure("exit 1", &error).contains("server returned HTTP 503"));
    }

    #[test]
    fn download_error_retains_a_bounded_actionable_message() {
        let mut input = vec![b'x'; 12000];
        input.extend_from_slice(b"\nError: server returned HTTP 503\n");
        let error = read_error_tail(&input[..]).unwrap();
        assert!(error.len() <= 8192);
        assert!(download_failure("exit 1", &error).contains("server returned HTTP 503"));
        assert!(download_failure("exit 1", "").contains("did not report a reason"));
    }

    #[test]
    fn extractor_keeps_final_unterminated_diagnostic() {
        let output = b"fetching chunks 50% |\rstorage error without newline";
        let error = read_extract_progress(&output[..], |_| {}).unwrap().unwrap();
        assert!(error.contains("storage error"));
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
    request_id: String,
) -> Result<(), String> {
    if request_id.is_empty() || request_id.len() > 100 {
        return Err("Invalid map download request.".into());
    }
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
            #[cfg(not(all(
                any(target_os = "linux", target_os = "windows"),
                target_arch = "x86_64"
            )))]
            return Err(
                "Map downloading is currently available on Linux and Windows x86-64 only.".into(),
            );
            #[cfg(all(
                any(target_os = "linux", target_os = "windows"),
                target_arch = "x86_64"
            ))]
            {
                #[cfg(target_os = "linux")]
                use std::os::unix::process::CommandExt;
                #[cfg(target_os = "windows")]
                use std::os::windows::process::CommandExt;
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
                let output = tempfile::NamedTempFile::new_in(&dir)
                    .map_err(|e| e.to_string())?
                    .into_temp_path();
                #[cfg(target_os = "linux")]
                let staged_path = {
                    let binary = app
                        .path()
                        .resource_dir()
                        .map_err(|e| e.to_string())?
                        .join("pmtiles-linux-x86_64.gz");
                    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("resources/pmtiles-linux-x86_64.gz");
                    stage_extractor(if binary.is_file() { &binary } else { &dev }, &dir)?
                };
                #[cfg(target_os = "windows")]
                let staged_path = {
                    let binary = app
                        .path()
                        .resource_dir()
                        .map_err(|e| e.to_string())?
                        .join("pmtiles-windows-x86_64.exe");
                    if !binary.is_file() {
                        return Err(
                            "Windows map downloader is missing from the application directory."
                                .into(),
                        );
                    }
                    binary
                };
                let output_path = output.to_path_buf();
                let mut command = std::process::Command::new(&staged_path);
                command
                    .arg("extract")
                    .arg("https://data.source.coop/protomaps/openstreetmap/v4.pmtiles")
                    .arg(&output_path)
                    .arg(format!("--region={}", region.path().display()))
                    .arg(format!("--maxzoom={zoom}"))
                    .arg("--download-threads=2")
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped());
                #[cfg(target_os = "windows")]
                command.creation_flags(0x08000000);
                #[cfg(target_os = "linux")]
                let parent = std::process::id();
                #[cfg(target_os = "linux")]
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
                #[cfg(target_os = "linux")]
                drop(staged_path);
                let stdout = child
                    .stdout
                    .take()
                    .ok_or("Could not read map download progress")?;
                let stderr = child
                    .stderr
                    .take()
                    .ok_or("Could not read map downloader errors")?;
                let error_thread =
                    std::thread::spawn(move || read_error_tail(stderr).unwrap_or_default());
                let progress_app = app.clone();
                let progress_thread = std::thread::spawn(move || {
                    read_extract_progress(stdout, |percent| {
                        let _ = progress_app.emit(
                            "map-download-progress",
                            serde_json::json!({ "requestId": request_id, "percent": percent }),
                        );
                    })
                    .ok()
                    .flatten()
                });
                loop {
                    if cancel.load(Ordering::SeqCst) {
                        let _ = child.kill();
                        let _ = child.wait();
                        let _ = progress_thread.join();
                        let _ = error_thread.join();
                        return Err("Map download canceled.".into());
                    }
                    match child.try_wait().map_err(|e| e.to_string())? {
                        Some(status) if status.success() => break,
                        Some(status) => {
                            let stdout_error =
                                progress_thread.join().ok().flatten().unwrap_or_default();
                            let stderr_error = error_thread.join().unwrap_or_default();
                            let detail = if stderr_error.trim().is_empty() {
                                &stdout_error
                            } else {
                                &stderr_error
                            };
                            return Err(download_failure(status, detail));
                        }
                        None => std::thread::sleep(Duration::from_millis(300)),
                    }
                }
                let _ = progress_thread.join();
                let _ = error_thread.join();
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
