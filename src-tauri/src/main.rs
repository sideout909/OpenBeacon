#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod beacon;
mod gps;
mod history;
mod maps;
mod messaging;
mod tnc;
mod weather;

use openbeacon_packet::{
    aprs::{decode_tnc2, DecodedPacket, PacketOrigin},
    tnc2::{Line, LineDecoder},
};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

#[derive(Default)]
struct Connection(Arc<AtomicU64>);
#[derive(Clone, Serialize)]
struct Status {
    origin: PacketOrigin,
    code: Option<&'static str>,
    state: String,
    message: String,
    generation: u64,
}
#[derive(Clone, Serialize)]
struct Packets {
    packets: Vec<DecodedPacket>,
    generation: u64,
}
fn emit_status(app: &tauri::AppHandle, generation: u64, state: &str, message: &str) {
    let _ = app.emit(
        "aprs-status",
        Status {
            origin: PacketOrigin::AprsIs,
            code: match (state, message) {
                ("error", "Unable to send the receive-only login") => Some("login_write_failed"),
                ("error", _) => Some("connection_failed"),
                _ => None,
            },
            state: state.into(),
            message: message.into(),
            generation,
        },
    );
}
fn active(token: &AtomicU64, generation: u64) -> bool {
    token.load(Ordering::SeqCst) == generation
}
fn delay(token: &AtomicU64, generation: u64, seconds: u64) {
    for _ in 0..seconds * 4 {
        if !active(token, generation) {
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}
#[tauri::command]
fn connect_aprs(
    app: tauri::AppHandle,
    state: State<'_, Connection>,
    callsign: String,
    lat: f64,
    lon: f64,
    radius: u32,
) -> Result<u64, String> {
    let call = callsign.trim().to_ascii_uppercase();
    let mut parts = call.split('-');
    let base = parts.next().unwrap_or("");
    let suffix = parts.next();
    if call.len() > 9
        || base.len() < 3
        || !base.bytes().all(|b| b.is_ascii_alphanumeric())
        || parts.next().is_some()
        || suffix.is_some_and(|s| {
            s.is_empty() || s.len() > 2 || !s.bytes().all(|b| b.is_ascii_alphanumeric())
        })
    {
        return Err("Enter a valid callsign and optional SSID.".into());
    }
    if !lat.is_finite()
        || !lon.is_finite()
        || !(-90.0..=90.0).contains(&lat)
        || !(-180.0..=180.0).contains(&lon)
        || !(1..=2000).contains(&radius)
    {
        return Err("Enter valid coordinates and a radius between 1 and 2000 km.".into());
    }
    let generation = state.0.fetch_add(1, Ordering::SeqCst) + 1;
    let token = state.0.clone();
    std::thread::spawn(move || {
        let mut retry = 1;
        while active(&token, generation) {
            emit_status(&app, generation, "connecting", "Connecting to APRS-IS…");
            let address = ("rotate.aprs2.net", 14580)
                .to_socket_addrs()
                .ok()
                .and_then(|mut a| a.next());
            let result = address
                .ok_or_else(|| "Could not resolve the APRS-IS server".to_string())
                .and_then(|a| {
                    TcpStream::connect_timeout(&a, Duration::from_secs(8))
                        .map_err(|e| e.to_string())
                });
            match result {
                Ok(mut stream) => {
                    if !active(&token, generation) {
                        break;
                    }
                    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
                    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
                    let login = format!("user {call} pass -1 vers OpenBeacon 0.1 filter r/{lat:.5}/{lon:.5}/{radius} g/{call}\r\n");
                    if stream.write_all(login.as_bytes()).is_err() {
                        emit_status(
                            &app,
                            generation,
                            "error",
                            "Unable to send the receive-only login",
                        );
                    } else {
                        emit_status(&app, generation, "connecting", "Waiting for server login…");
                        retry = 1;
                        let mut buf = [0u8; 8192];
                        let mut framing = LineDecoder::default();
                        let mut batch = Vec::new();
                        while active(&token, generation) {
                            match stream.read(&mut buf) {
                                Ok(0) => break,
                                Ok(n) => {
                                    for line in framing.feed(&buf[..n]) {
                                        match line {
                                            Line::Data(line) if line.starts_with(b"# logresp") => {
                                                emit_status(
                                                    &app,
                                                    generation,
                                                    "connected",
                                                    "Connected",
                                                )
                                            }
                                            Line::Data(line) if !line.starts_with(b"#") => {
                                                let mut packet = decode_tnc2(&line);
                                                packet.origin = PacketOrigin::AprsIs;
                                                batch.push(packet)
                                            }
                                            _ => {}
                                        }
                                    }
                                }
                                Err(e)
                                    if matches!(
                                        e.kind(),
                                        std::io::ErrorKind::WouldBlock
                                            | std::io::ErrorKind::TimedOut
                                    ) => {}
                                Err(_) => break,
                            }
                            if !batch.is_empty() && active(&token, generation) {
                                if let Err(error) = history::save(&app, &batch) {
                                    let _ = app.emit("history-error", error);
                                }
                                let _ = app.emit(
                                    "aprs-packets",
                                    Packets {
                                        packets: std::mem::take(&mut batch),
                                        generation,
                                    },
                                );
                            }
                        }
                    }
                }
                Err(e) => emit_status(
                    &app,
                    generation,
                    "error",
                    &format!("Connection failed: {e}"),
                ),
            }
            if active(&token, generation) {
                emit_status(
                    &app,
                    generation,
                    "reconnecting",
                    &format!("Reconnecting in {retry}s"),
                );
                delay(&token, generation, retry);
                retry = (retry * 2).min(30);
            }
        }
    });
    Ok(generation)
}
#[derive(Clone, Serialize, Deserialize)]
struct SavedSettings {
    callsign: String,
    lat: f64,
    lon: f64,
    radius: u32,
    #[serde(default = "previous_location_default")]
    location_set: bool,
    #[serde(default = "default_station_symbol")]
    symbol: String,
    #[serde(default = "default_theme")]
    theme: String,
    #[serde(default)]
    beacon_comment: String,
    #[serde(default = "default_rf_path")]
    rf_path: String,
}
fn default_rf_path() -> String {
    "WIDE2-2".into()
}
fn default_theme() -> String {
    "system".into()
}
fn default_station_symbol() -> String {
    "/-".into()
}
fn previous_location_default() -> bool {
    true
}

#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> Result<Option<SavedSettings>, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("settings.json");
    match std::fs::read(path) {
        Ok(contents) => serde_json::from_slice(&contents)
            .map(Some)
            .map_err(|e| format!("Could not read saved settings: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Could not read saved settings: {e}")),
    }
}
fn valid_rf_path(path: &str) -> bool {
    path.is_empty()
        || (path.len() <= 71
            && path.split(',').count() <= 8
            && path.split(',').all(|part| {
                let mut fields = part.split('-');
                let call = fields.next().unwrap_or("");
                let ssid = fields.next();
                !call.is_empty()
                    && call.len() <= 6
                    && call
                        .bytes()
                        .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
                    && ssid.is_none_or(|v| {
                        !v.is_empty()
                            && v.bytes().all(|b| b.is_ascii_digit())
                            && v.parse::<u8>().is_ok_and(|n| n <= 15)
                    })
                    && fields.next().is_none()
            }))
}
#[tauri::command]
fn save_settings(app: tauri::AppHandle, settings: SavedSettings) -> Result<(), String> {
    if !matches!(settings.theme.as_str(), "system" | "light" | "dark")
        || settings.symbol.len() != 2
        || !settings.symbol.is_ascii()
        || settings.beacon_comment.len() > 40
        || !settings
            .beacon_comment
            .bytes()
            .all(|b| (32..=126).contains(&b))
        || !valid_rf_path(&settings.rf_path)
        || settings.callsign.len() > 9
        || !settings.lat.is_finite()
        || !settings.lon.is_finite()
        || !(-90.0..=90.0).contains(&settings.lat)
        || !(-180.0..=180.0).contains(&settings.lon)
        || !(1..=2000).contains(&settings.radius)
    {
        return Err(
            "Enter a callsign, valid coordinates, and a radius between 1 and 2000 km.".into(),
        );
    }
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create settings directory: {e}"))?;
    let json = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("settings.json"), json)
        .map_err(|e| format!("Could not save settings: {e}"))
}
#[tauri::command]
fn disconnect_aprs(state: State<'_, Connection>) {
    state.0.fetch_add(1, Ordering::SeqCst);
}
#[tauri::command]
fn open_map_provider(app: tauri::AppHandle) -> Result<(), String> {
    app.opener()
        .open_url("https://protomaps.com/api", None::<&str>)
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn open_passcode_generator(app: tauri::AppHandle) -> Result<(), String> {
    app.opener()
        .open_url("https://aprs.do3sww.de/", None::<&str>)
        .map_err(|e| e.to_string())
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.manage(Connection::default());
            app.manage(gps::Gps::default());
            app.manage(weather::WeatherState::default());
            app.manage(tnc::Tnc::default());
            app.manage(maps::MapDownload::default());
            app.manage(tnc::Modem::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            weather::save_weather_credentials,
            weather::weather_station_saved,
            weather::clear_weather_credentials,
            weather::fetch_weather,
            weather::read_peet_weather,
            weather::send_weather,
            gps::connect_gps,
            gps::disconnect_gps,
            maps::read_map_range,
            maps::read_downloaded_map,
            maps::download_region_map,
            maps::cancel_map_download,
            tnc::connect_tnc,
            tnc::connect_serial_tnc,
            tnc::list_serial_devices,
            tnc::list_capture_devices,
            tnc::start_direwolf,
            tnc::stop_direwolf,
            tnc::disconnect_tnc,
            history::load_history,
            beacon::send_position_beacon,
            messaging::send_aprs_message,
            tnc::send_rf_beacon,
            beacon::save_aprs_passcode,
            beacon::aprs_passcode_saved,
            beacon::clear_aprs_passcode,
            open_passcode_generator,
            open_map_provider,
            connect_aprs,
            disconnect_aprs,
            load_settings,
            save_settings
        ])
        .build(tauri::generate_context!())
        .expect("failed to build OpenBeacon")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                tnc::shutdown(app);
                gps::shutdown(app);
            }
        });
}
