use serde::Serialize;
use std::{
    io::Read,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, State};

#[derive(Default)]
pub struct Gps(Arc<AtomicU64>);
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Fix {
    lat: f64,
    lon: f64,
    speed_knots: Option<f64>,
    course: Option<f64>,
    received_at: u64,
}
#[derive(Clone, Serialize)]
struct Event {
    generation: u64,
    state: &'static str,
    message: String,
    fix: Option<Fix>,
}
fn parse_rmc(line: &str) -> Result<Option<Fix>, ()> {
    let (data, checksum) = line
        .trim()
        .strip_prefix('$')
        .ok_or(())?
        .split_once('*')
        .ok_or(())?;
    if checksum.len() != 2
        || u8::from_str_radix(checksum, 16).map_err(|_| ())?
            != data.bytes().fold(0, |sum, b| sum ^ b)
    {
        return Err(());
    }
    let fields: Vec<_> = data.split(',').collect();
    if fields
        .first()
        .is_none_or(|s| s.len() != 5 || !s.ends_with("RMC"))
    {
        return Ok(None);
    }
    if fields.len() < 10 {
        return Err(());
    }
    if fields[2] != "A" || fields.get(12).is_some_and(|mode| *mode == "N") {
        return Ok(None);
    }
    fn coord(value: &str, hemi: &str, digits: usize, max: f64) -> Result<f64, ()> {
        if value.len() < digits + 2 || !value.is_ascii() {
            return Err(());
        }
        let degrees: f64 = value[..digits].parse().map_err(|_| ())?;
        let minutes: f64 = value[digits..].parse().map_err(|_| ())?;
        let val = degrees + minutes / 60.0;
        if !degrees.is_finite()
            || !minutes.is_finite()
            || !(0.0..60.0).contains(&minutes)
            || val > max
        {
            return Err(());
        }
        match hemi {
            "N" | "E" => Ok(val),
            "S" | "W" => Ok(-val),
            _ => Err(()),
        }
    }
    let lat = coord(fields[3], fields[4], 2, 90.0)?;
    let lon = coord(fields[5], fields[6], 3, 180.0)?;
    if !matches!(fields[4], "N" | "S") || !matches!(fields[6], "E" | "W") {
        return Err(());
    }
    fn optional(value: &str, upper: f64) -> Result<Option<f64>, ()> {
        if value.is_empty() {
            return Ok(None);
        }
        let x: f64 = value.parse().map_err(|_| ())?;
        if !x.is_finite() || x < 0.0 || x > upper {
            return Err(());
        }
        Ok(Some(x))
    }
    Ok(Some(Fix {
        lat,
        lon,
        speed_knots: optional(fields[7], 999.0)?,
        course: optional(fields[8], 360.0)?.map(|v| v % 360.0),
        received_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| ())?
            .as_millis() as u64,
    }))
}
#[tauri::command]
pub fn connect_gps(
    app: tauri::AppHandle,
    state: State<'_, Gps>,
    port: String,
    baud: u32,
) -> Result<u64, String> {
    if port.trim().is_empty() || port.len() > 512 || !(300..=921600).contains(&baud) {
        return Err("Choose a valid GPS serial port and baud rate.".into());
    }
    let generation = state.0.fetch_add(1, Ordering::SeqCst) + 1;
    let token = state.0.clone();
    std::thread::spawn(move || {
        let emit = |state, message: String, fix| {
            let _ = app.emit(
                "gps-status",
                Event {
                    generation,
                    state,
                    message,
                    fix,
                },
            );
        };
        emit("connecting", format!("Opening {port}…"), None);
        let mut serial = match serialport::new(&port, baud)
            .timeout(Duration::from_millis(250))
            .open()
        {
            Ok(p) => p,
            Err(e) => {
                emit(
                    "error",
                    format!("Could not open GPS port {port}: {e}"),
                    None,
                );
                return;
            }
        };
        emit(
            "connected",
            format!("GPS connected · waiting for valid RMC fix · {port}"),
            None,
        );
        let mut line = Vec::new();
        let mut bytes = [0u8; 512];
        let mut discard = false;
        while token.load(Ordering::SeqCst) == generation {
            match serial.read(&mut bytes) {
                Ok(n) => {
                    for &b in &bytes[..n] {
                        if b == b'\n' {
                            if !discard {
                                if let Ok(text) = std::str::from_utf8(&line) {
                                    if let Ok(Some(fix)) = parse_rmc(text) {
                                        emit("fix", "GPS fix".into(), Some(fix));
                                    }
                                }
                            }
                            line.clear();
                            discard = false;
                        } else if !discard && line.len() < 1024 {
                            line.push(b);
                        } else {
                            discard = true;
                        }
                    }
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                    ) => {}
                Err(e) => {
                    emit("error", format!("GPS read failed: {e}"), None);
                    break;
                }
            }
        }
    });
    Ok(generation)
}
#[tauri::command]
pub fn disconnect_gps(state: State<'_, Gps>) {
    state.0.fetch_add(1, Ordering::SeqCst);
}
pub fn shutdown(app: &tauri::AppHandle) {
    use tauri::Manager;
    app.state::<Gps>().0.fetch_add(1, Ordering::SeqCst);
}
#[cfg(test)]
mod tests {
    use super::*;
    fn sentence(data: &str) -> String {
        format!("${data}*{:02X}", data.bytes().fold(0, |x, b| x ^ b))
    }
    #[test]
    fn parses_valid_rmc_and_rejects_void_bad_checksum_and_bad_coordinates() {
        let v = sentence("GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W");
        let fix = parse_rmc(&v).unwrap().unwrap();
        assert!((fix.lat - 48.1173).abs() < 1e-6);
        assert!((fix.lon - 11.5166667).abs() < 1e-6);
        assert_eq!(fix.speed_knots, Some(22.4));
        assert!(parse_rmc(&v.replace("4807", "4907")).is_err());
        assert!(parse_rmc(&sentence(
            "GNRMC,123519,V,4807.038,N,01131.000,E,0,0,230394,,,N"
        ))
        .unwrap()
        .is_none());
        assert!(parse_rmc(&sentence(
            "GPRMC,123519,A,4860.000,N,01131.000,E,0,0,230394,,"
        ))
        .is_err());
    }
}
