use serde::{Deserialize, Serialize};
use std::io::Write;
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
pub(crate) fn transmit(
    app: &tauri::AppHandle,
    call: &str,
    passcode: &str,
    payload: &str,
) -> Result<String, String> {
    crate::aprs_session::client(app)?.send(
        crate::aprs_session::Credentials {
            call: call.into(),
            pass: Some(passcode.into()),
        },
        payload.into(),
    )
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
pub async fn save_aprs_passcode(
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
        callsign: base.clone(),
        passcode: passcode.clone(),
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
    file.write_all(&data).map_err(|e| e.to_string())?;
    let client = crate::aprs_session::client(&app)?;
    tauri::async_runtime::spawn_blocking(move || client.credentials_changed(base, Some(passcode)))
        .await
        .map_err(|e| e.to_string())?
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
    if saved.passcode.is_empty()
        || saved.passcode.len() > 5
        || !saved.passcode.bytes().all(|b| b.is_ascii_digit())
    {
        return Err("The saved APRS-IS passcode is invalid. Save it again in My Station.".into());
    }
    Ok(saved.passcode)
}
#[tauri::command]
pub fn aprs_passcode_saved(app: tauri::AppHandle, callsign: String) -> bool {
    load_passcode(&app, &callsign).is_ok()
}
#[tauri::command]
pub async fn clear_aprs_passcode(app: tauri::AppHandle) -> Result<(), String> {
    let path = credential_path(&app)?;
    let saved = std::fs::read(&path)
        .ok()
        .and_then(|data| serde_json::from_slice::<Passcode>(&data).ok());
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    if let Some(saved) = saved {
        let client = crate::aprs_session::client(&app)?;
        tauri::async_runtime::spawn_blocking(move || {
            client.credentials_changed(saved.callsign, None)
        })
        .await
        .map_err(|e| e.to_string())??;
    }
    Ok(())
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
    tauri::async_runtime::spawn_blocking(move || transmit(&app, &call, &passcode, &payload))
        .await
        .map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
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
