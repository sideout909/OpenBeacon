use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;
use tauri::Manager;

pub(crate) fn position(lat: f64, lon: f64, symbol: &str) -> Result<String, String> {
    if !lat.is_finite()
        || !lon.is_finite()
        || lat.abs() > 90.0
        || lon.abs() > 180.0
        || symbol.len() != 2
        || !symbol.is_ascii()
    {
        return Err("Invalid position or symbol".into());
    }
    fn coord(value: f64, width: usize, positive: char, negative: char) -> String {
        let hundredths = (value.abs() * 6000.0).round() as u32;
        let degrees = hundredths / 6000;
        let minutes = hundredths % 6000;
        format!(
            "{degrees:0width$}{:02}.{:02}{}",
            minutes / 100,
            minutes % 100,
            if value < 0.0 { negative } else { positive }
        )
    }
    let chars: Vec<char> = symbol.chars().collect();
    if !(chars[0] == '/' || chars[0] == '\\' || chars[0].is_ascii_alphanumeric())
        || !(('!'..='~').contains(&chars[1]))
    {
        return Err("Invalid symbol".into());
    }
    Ok(format!(
        "!{}{}{}{}",
        coord(lat, 2, 'N', 'S'),
        chars[0],
        coord(lon, 3, 'E', 'W'),
        chars[1]
    ))
}
pub(crate) fn position_payload(
    lat: f64,
    lon: f64,
    symbol: &str,
    comment: &str,
    speed_knots: Option<f64>,
    course: Option<f64>,
) -> Result<String, String> {
    if comment.len() > 40 || !comment.bytes().all(|b| (32..=126).contains(&b)) {
        return Err("Beacon comment must be at most 40 printable ASCII characters".into());
    }
    let motion = match (speed_knots, course) {
        (Some(speed), Some(direction))
            if speed.is_finite()
                && (0.0..=999.0).contains(&speed)
                && direction.is_finite()
                && (0.0..360.0).contains(&direction) =>
        {
            format!(
                "{:03}/{:03}",
                if direction.round() == 0.0 {
                    360
                } else {
                    direction.round() as u32
                },
                speed.round() as u32
            )
        }
        (None, None) => String::new(),
        _ => return Err("Invalid GPS speed or course".into()),
    };
    Ok(format!(
        "{}{}{}",
        position(lat, lon, symbol)?,
        motion,
        comment
    ))
}
pub(crate) fn transmit(call: &str, passcode: &str, payload: &str) -> Result<String, String> {
    let address = ("rotate.aprs2.net", 14580)
        .to_socket_addrs()
        .map_err(|e| e.to_string())?
        .next()
        .ok_or("Server could not be resolved")?;
    let stream =
        TcpStream::connect_timeout(&address, Duration::from_secs(8)).map_err(|e| e.to_string())?;
    exchange(stream, call, passcode, payload)
}
fn exchange(
    mut stream: TcpStream,
    call: &str,
    passcode: &str,
    payload: &str,
) -> Result<String, String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(8)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(8)))
        .map_err(|e| e.to_string())?;
    write!(
        stream,
        "user {call} pass {passcode} vers OpenBeacon 0.1\r\n"
    )
    .map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    let mut verified = false;
    for _ in 0..20 {
        let mut line = String::new();
        if reader.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
            break;
        }
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("# logresp ") {
            let fields: Vec<_> = lower.split_whitespace().collect();
            verified = fields
                .get(2)
                .is_some_and(|v| v.trim_end_matches(',') == call.to_ascii_lowercase())
                && fields
                    .get(3)
                    .is_some_and(|v| v.trim_end_matches(',') == "verified");
            break;
        }
    }
    if !verified {
        return Err("APRS-IS did not verify the callsign and passcode; no packet sent.".into());
    }
    write!(stream, "{call}>APRS,TCPIP*:{payload}\r\n")
        .map_err(|e| format!("Send failed; outcome may be unknown: {e}"))?;
    Ok(format!("{call}>APRS,TCPIP*:{payload}"))
}
#[derive(Serialize, Deserialize)]
struct Passcode {
    callsign: String,
    passcode: String,
}
fn credential_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("aprs-is-passcode.json"))
}
#[tauri::command]
pub fn save_aprs_passcode(
    app: tauri::AppHandle,
    callsign: String,
    passcode: String,
) -> Result<(), String> {
    let base = callsign
        .trim()
        .split('-')
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    if !(3..=6).contains(&base.len())
        || !base.bytes().all(|b| b.is_ascii_alphanumeric())
        || passcode.is_empty()
        || passcode.len() > 5
        || !passcode.bytes().all(|b| b.is_ascii_digit())
    {
        return Err("Enter a callsign and a numeric APRS-IS passcode.".into());
    }
    let data = serde_json::to_vec(&Passcode {
        callsign: base,
        passcode,
    })
    .map_err(|e| e.to_string())?;
    let path = credential_path(&app)?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    file.write_all(&data).map_err(|e| e.to_string())
}
pub(crate) fn load_passcode(app: &tauri::AppHandle, callsign: &str) -> Result<String, String> {
    let data = std::fs::read(credential_path(app)?)
        .map_err(|_| "Save an APRS-IS passcode in My Station first.".to_string())?;
    let saved: Passcode = serde_json::from_slice(&data)
        .map_err(|_| "Could not read the saved APRS-IS passcode.".to_string())?;
    if saved.callsign
        != callsign
            .split('-')
            .next()
            .unwrap_or("")
            .to_ascii_uppercase()
    {
        return Err(
            "The saved passcode belongs to a different callsign. Update it in My Station.".into(),
        );
    }
    Ok(saved.passcode)
}
#[tauri::command]
pub fn aprs_passcode_saved(app: tauri::AppHandle, callsign: String) -> bool {
    load_passcode(&app, &callsign).is_ok()
}
#[tauri::command]
pub fn clear_aprs_passcode(app: tauri::AppHandle) -> Result<(), String> {
    match std::fs::remove_file(credential_path(&app)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn send_position_beacon(
    app: tauri::AppHandle,
    callsign: String,
    lat: f64,
    lon: f64,
    symbol: String,
    comment: String,
    speed_knots: Option<f64>,
    course: Option<f64>,
) -> Result<String, String> {
    let call = callsign.trim().to_ascii_uppercase();
    let mut parts = call.split('-');
    let base = parts.next().unwrap_or("");
    let ssid = parts.next();
    if !(3..=6).contains(&base.len())
        || !base.bytes().all(|b| b.is_ascii_alphanumeric())
        || parts.next().is_some()
        || ssid.is_some_and(|v| v.parse::<u8>().map_or(true, |n| n > 15))
    {
        return Err("Invalid callsign or SSID".into());
    }
    let passcode = load_passcode(&app, &call)?;
    if passcode.is_empty() || passcode.len() > 5 || !passcode.bytes().all(|b| b.is_ascii_digit()) {
        return Err("Enter a valid APRS-IS passcode".into());
    }
    let payload = position_payload(lat, lon, &symbol, &comment, speed_knots, course)?;
    tauri::async_runtime::spawn_blocking(move || transmit(&call, &passcode, &payload))
        .await
        .map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sends_only_after_verified_login() {
        use std::net::TcpListener;
        for verified in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut login = String::new();
                reader.read_line(&mut login).unwrap();
                assert!(login.starts_with("user N0ABC pass 123 "));
                write!(
                    stream,
                    "# logresp N0ABC {}, server test\r\n",
                    if verified { "verified" } else { "unverified" }
                )
                .unwrap();
                let mut packet = String::new();
                let _ = reader.read_line(&mut packet);
                packet
            });
            let result = exchange(TcpStream::connect(addr).unwrap(), "N0ABC", "123", "!test");
            let packet = server.join().unwrap();
            assert_eq!(result.is_ok(), verified);
            assert_eq!(!packet.is_empty(), verified);
            if verified {
                assert_eq!(packet, "N0ABC>APRS,TCPIP*:!test\r\n");
            }
        }
    }
    #[test]
    fn encodes_position_and_rounds_minutes() {
        assert_eq!(
            position(42.3314, -83.0458, "/-").unwrap(),
            "!4219.88N/08302.75W-"
        );
        assert_eq!(
            position(42.9999999, 0.0, "/>").unwrap(),
            "!4300.00N/00000.00E>"
        );
        assert!(position(f64::NAN, 0.0, "/-").is_err());
    }
}
