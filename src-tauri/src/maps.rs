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
