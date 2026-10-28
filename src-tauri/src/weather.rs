//! Weather source acquisition, freshness checks, and APRS transmission.
use crate::{
    beacon,
    tnc::{self, Tnc},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, State};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    source: String,
    observed_at: u64,
    lat: f64,
    lon: f64,
    temperature: Option<f64>,
    wind_direction: Option<f64>,
    wind_speed: Option<f64>,
    wind_gust: Option<f64>,
    humidity: Option<f64>,
    pressure_hpa: Option<f64>,
    source_last_change_at: Option<u64>,
}
#[derive(Default)]
pub struct WeatherState(Mutex<Option<Observation>>, Mutex<()>);
#[derive(Serialize, Deserialize)]
struct Credentials {
    station: String,
    key: String,
}
fn credential_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("weather-underground.json"))
}
#[tauri::command]
pub fn save_weather_credentials(
    app: tauri::AppHandle,
    state: State<'_, WeatherState>,
    station: String,
    key: String,
) -> Result<(), String> {
    *state.0.lock().map_err(|_| "Weather source unavailable")? = None;
    let station = station.trim().to_ascii_uppercase();
    let key = key.trim().to_string();
    if station.is_empty()
        || station.len() > 30
        || !station
            .bytes()
            .all(|x| x.is_ascii_alphanumeric() || x == b'-')
        || key.is_empty()
        || key.len() > 128
        || !key
            .bytes()
            .all(|x| x.is_ascii_alphanumeric() || x == b'-' || x == b'_')
    {
        return Err("Enter a valid PWS station ID and Weather Underground API key.".into());
    }
    let data = serde_json::to_vec(&Credentials { station, key })
        .map_err(|_| "Could not save weather credentials")?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(credential_path(&app)?)
        .map_err(|_| "Could not save weather credentials")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "Could not secure weather credentials")?;
    }
    file.write_all(&data)
        .map_err(|_| "Could not save weather credentials".into())
}
#[tauri::command]
pub fn weather_station_saved(app: tauri::AppHandle) -> Option<String> {
    std::fs::read(credential_path(&app).ok()?)
        .ok()
        .and_then(|v| serde_json::from_slice::<Credentials>(&v).ok())
        .map(|x| x.station)
}
#[tauri::command]
pub fn clear_weather_credentials(
    app: tauri::AppHandle,
    state: State<'_, WeatherState>,
) -> Result<(), String> {
    *state.0.lock().map_err(|_| "Weather source unavailable")? = None;
    match std::fs::remove_file(credential_path(&app)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Could not remove weather credentials".into()),
    }
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn fresh(obs: &Observation) -> bool {
    obs.observed_at <= now() + 60
        && now().saturating_sub(obs.observed_at) < 1200
        && obs
            .source_last_change_at
            .is_none_or(|changed| changed <= now() && now().saturating_sub(changed) < 1200)
}
#[derive(Serialize, Deserialize)]
struct WuFreshness {
    values: [Option<f64>; 6],
    last_change: u64,
    last_observed: u64,
}
fn update_wu_freshness(
    path: &std::path::Path,
    obs: &mut Observation,
    current: u64,
) -> Result<(), String> {
    let mut all: HashMap<String, WuFreshness> = match std::fs::read(path) {
        Ok(data) => serde_json::from_slice(&data)
            .map_err(|_| "Cannot verify stored weather freshness; transmission is paused.")?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
        Err(_) => {
            return Err("Cannot read stored weather freshness; transmission is paused.".into())
        }
    };
    let values = [
        obs.temperature,
        obs.wind_direction,
        obs.wind_speed,
        obs.wind_gust,
        obs.humidity,
        obs.pressure_hpa,
    ];
    let entry = all
        .entry(obs.source.to_ascii_uppercase())
        .or_insert(WuFreshness {
            values,
            last_change: current,
            last_observed: obs.observed_at,
        });
    if entry.last_change > current || entry.last_observed > obs.observed_at {
        return Err(
            "Weather observation or local clock moved backwards; freshness cannot be verified."
                .into(),
        );
    }
    if obs.observed_at > entry.last_observed {
        let changed = values
            .iter()
            .zip(entry.values.iter())
            .any(|(new, old)| matches!((new, old), (Some(a), Some(b)) if a != b));
        if changed {
            entry.last_change = current;
        }
        for (old, new) in entry.values.iter_mut().zip(values) {
            if new.is_some() {
                *old = new;
            }
        }
        entry.last_observed = obs.observed_at;
    }
    obs.source_last_change_at = Some(entry.last_change);
    let dir = path.parent().ok_or("Cannot save weather freshness.")?;
    std::fs::create_dir_all(dir).map_err(|_| "Cannot save weather freshness.")?;
    let mut temp =
        tempfile::NamedTempFile::new_in(dir).map_err(|_| "Cannot save weather freshness.")?;
    serde_json::to_writer(&mut temp, &all).map_err(|_| "Cannot save weather freshness.")?;
    temp.persist(path)
        .map_err(|_| "Cannot save weather freshness.")?;
    Ok(())
}
fn bounded(v: Option<f64>, low: f64, high: f64) -> Option<f64> {
    v.filter(|x| x.is_finite() && *x >= low && *x <= high)
}
#[derive(Deserialize)]
struct Wunderground {
    observations: Vec<WuObservation>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WuObservation {
    #[serde(rename = "stationID")]
    station_id: String,
    epoch: u64,
    lat: f64,
    lon: f64,
    winddir: Option<f64>,
    humidity: Option<f64>,
    qc_status: Option<i8>,
    imperial: WuImperial,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WuImperial {
    temp: Option<f64>,
    wind_speed: Option<f64>,
    wind_gust: Option<f64>,
    pressure: Option<f64>,
}
fn from_wu(data: Wunderground, station: &str) -> Result<Observation, String> {
    let w = data
        .observations
        .into_iter()
        .find(|o| o.station_id.eq_ignore_ascii_case(station))
        .ok_or("No current observation for this station.")?;
    if w.qc_status == Some(0) {
        return Err("Weather Underground reports this station is failing quality control.".into());
    }
    if !w.lat.is_finite()
        || !w.lon.is_finite()
        || !(-90.0..=90.0).contains(&w.lat)
        || !(-180.0..=180.0).contains(&w.lon)
    {
        return Err("The weather station did not provide a valid position.".into());
    }
    let o = Observation {
        source: w.station_id,
        observed_at: w.epoch,
        lat: w.lat,
        lon: w.lon,
        temperature: bounded(w.imperial.temp, -99., 999.),
        wind_direction: bounded(w.winddir, 0., 360.),
        wind_speed: bounded(w.imperial.wind_speed, 0., 999.),
        wind_gust: bounded(w.imperial.wind_gust, 0., 999.),
        humidity: bounded(w.humidity, 0., 100.),
        pressure_hpa: bounded(w.imperial.pressure.map(|p| p * 33.8638866667), 800., 1100.),
        source_last_change_at: None,
    };
    if !fresh(&o) {
        return Err(
            "The weather observation is older than 20 minutes or has an invalid time.".into(),
        );
    }
    if o.temperature.is_none()
        && o.wind_speed.is_none()
        && o.wind_gust.is_none()
        && o.humidity.is_none()
        && o.pressure_hpa.is_none()
    {
        return Err("The observation has no usable weather measurements.".into());
    }
    Ok(o)
}
#[tauri::command]
pub async fn fetch_weather(
    app: tauri::AppHandle,
    state: State<'_, WeatherState>,
) -> Result<Observation, String> {
    *state.0.lock().map_err(|_| "Weather source unavailable")? = None;
    let data = std::fs::read(credential_path(&app)?)
        .map_err(|_| "Save a Weather Underground station ID and API key first.")?;
    let creds: Credentials =
        serde_json::from_slice(&data).map_err(|_| "Could not read weather credentials.")?;
    let mut obs = tauri::async_runtime::spawn_blocking(move || -> Result<Observation, String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "Could not initialize weather connection.")?;
        let response = client
            .get("https://api.weather.com/v2/pws/observations/current")
            .query(&[
                ("stationId", creds.station.as_str()),
                ("format", "json"),
                ("units", "e"),
                ("numericPrecision", "decimal"),
                ("apiKey", creds.key.as_str()),
            ])
            .send()
            .map_err(|_| "Could not reach Weather Underground.")?;
        if !response.status().is_success() {
            return Err(format!(
                "Weather Underground returned HTTP {}. Check the station ID and API key.",
                response.status().as_u16()
            ));
        }
        let mut body = Vec::new();
        response
            .take(1_000_001)
            .read_to_end(&mut body)
            .map_err(|_| "Could not read weather response.")?;
        if body.len() > 1_000_000 {
            return Err("Weather response was too large.".into());
        }
        let result = serde_json::from_slice(&body)
            .map_err(|_| "Weather Underground returned an invalid or expired observation.")?;
        from_wu(result, &creds.station)
    })
    .await
    .map_err(|_| "Weather request failed.")??;
    {
        let _guard = state
            .1
            .lock()
            .map_err(|_| "Weather freshness unavailable")?;
        let path = app
            .path()
            .app_config_dir()
            .map_err(|_| "Weather freshness unavailable")?
            .join("weather-freshness.json");
        update_wu_freshness(&path, &mut obs, now())?;
    }
    if !fresh(&obs) {
        return Err("Weather values have not changed for 20 minutes; transmission is paused until they change.".into());
    }
    *state.0.lock().map_err(|_| "Weather source unavailable")? = Some(obs.clone());
    Ok(obs)
}
// Peet Bros Ultimeter 100/800/2000 data logging and packet modes.
fn from_peet(line: &str, lat: f64, lon: f64) -> Option<Observation> {
    let (packet, data) = if let Some(data) = line.strip_prefix("$ULTW") {
        (true, data)
    } else {
        (false, line.strip_prefix("!!")?)
    };
    if data.len() < if packet { 44 } else { 40 }
        || !data.is_ascii()
        || !data.len().is_multiple_of(4)
    {
        return None;
    }
    if !data
        .as_bytes()
        .as_chunks::<4>()
        .0
        .iter()
        .all(|chunk| chunk == b"----" || chunk.iter().all(u8::is_ascii_hexdigit))
    {
        return None;
    }
    let fields: Vec<_> = data
        .as_bytes()
        .as_chunks::<4>()
        .0
        .iter()
        .map(|chunk| {
            std::str::from_utf8(chunk)
                .ok()
                .and_then(|x| u16::from_str_radix(x, 16).ok())
        })
        .collect();
    if fields.iter().all(Option::is_none) {
        return None;
    }
    let get = |i: usize| fields.get(i).copied().flatten();
    let temp = get(2).map(|v| f64::from(v as i16) / 10.);
    let speed = if packet { get(12) } else { get(0) }.map(|v| f64::from(v) / 10. * 0.621371);
    let gust = packet
        .then(|| get(0))
        .flatten()
        .map(|v| f64::from(v) / 10. * 0.621371);
    let direction = if packet {
        None
    } else {
        get(1).map(|v| f64::from(v & 255) * 360. / 256.)
    };
    Some(Observation {
        source: if packet {
            "Peet Bros Ultimeter packet mode"
        } else {
            "Peet Bros Ultimeter logging mode"
        }
        .into(),
        observed_at: now(),
        lat,
        lon,
        temperature: bounded(temp, -99., 999.),
        wind_direction: bounded(direction, 0., 360.),
        wind_speed: bounded(speed, 0., 999.),
        wind_gust: bounded(gust, 0., 999.),
        humidity: bounded(
            get(if packet { 8 } else { 6 }).map(|v| f64::from(v) / 10.),
            0.,
            100.,
        ),
        pressure_hpa: bounded(get(4).map(|v| f64::from(v) / 10.), 800., 1100.),
        source_last_change_at: None,
    })
}
#[tauri::command]
pub async fn read_peet_weather(
    state: State<'_, WeatherState>,
    port: String,
    lat: f64,
    lon: f64,
) -> Result<Observation, String> {
    *state.0.lock().map_err(|_| "Weather source unavailable")? = None;
    if !lat.is_finite()
        || !lon.is_finite()
        || !(-90.0..=90.0).contains(&lat)
        || !(-180.0..=180.0).contains(&lon)
    {
        return Err("Set a valid weather station location in My Station first.".into());
    }
    if port.trim().is_empty() || port.len() > 512 {
        return Err("Choose a serial port.".into());
    }
    let obs = tauri::async_runtime::spawn_blocking(move || -> Result<Observation, String> {
        let mut serial = serialport::new(port, 2400).timeout(Duration::from_millis(250)).open().map_err(|e| format!("Could not open weather serial port: {e}"))?;
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        let mut line = Vec::new(); let mut buf = [0u8; 128];
        while std::time::Instant::now() < deadline {
            match serial.read(&mut buf) {
                Ok(n) => for &b in &buf[..n] {
                    if b == b'\n' || b == b'\r' {
                        if let Ok(text) = std::str::from_utf8(&line) { if let Some(obs) = from_peet(text, lat, lon) { return Ok(obs); } }
                        line.clear();
                    } else if line.len() < 512 { line.push(b); } else { line.clear(); }
                },
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {},
                Err(_) => return Err("Weather serial read failed.".into()),
            }
        }
        Err("No supported Ultimeter data received in 15 seconds. Use data logging mode; packet mode reports only every five minutes.".into())
    }).await.map_err(|_| "Weather serial read failed.")??;
    *state.0.lock().map_err(|_| "Weather source unavailable")? = Some(obs.clone());
    Ok(obs)
}
fn weather_payload(o: &Observation) -> Result<String, String> {
    let mut packet = beacon::position(o.lat, o.lon, "/_")?;
    let n = |v: Option<f64>| {
        v.map(|x| format!("{:03}", x.round() as u16))
            .unwrap_or("...".into())
    };
    packet.push_str(&format!(
        "{}/{}",
        n(o.wind_direction.map(|x| if x == 0. { 360. } else { x })),
        n(o.wind_speed)
    ));
    if let Some(v) = o.wind_gust {
        packet.push_str(&format!("g{:03}", v.round() as u16));
    }
    if let Some(v) = o.temperature {
        let n = v.round() as i16;
        packet.push_str(&format!("t{n:03}"));
    }
    if let Some(v) = o.humidity {
        let n = v.round() as u16;
        if n > 0 {
            packet.push_str(&format!("h{:02}", if n == 100 { 0 } else { n }));
        }
    }
    if let Some(v) = o.pressure_hpa {
        packet.push_str(&format!("b{:05}", (v * 10.).round() as u16));
    }
    Ok(packet)
}
fn weather_callsign(callsign: &str) -> Result<String, String> {
    let call = callsign.trim().to_ascii_uppercase();
    let mut parts = call.split('-');
    let base = parts.next().unwrap_or_default();
    let ssid = parts.next();
    if !(3..=6).contains(&base.len())
        || !base.bytes().all(|b| b.is_ascii_alphanumeric())
        || parts.next().is_some()
        || ssid.is_some_and(|v| {
            v.is_empty()
                || v.len() > 2
                || !v.bytes().all(|b| b.is_ascii_digit())
                || !v.parse::<u8>().is_ok_and(|n| n <= 15)
        })
    {
        return Err("Set a valid callsign and SSID in My Station.".into());
    }
    Ok(format!("{base}-13"))
}
#[tauri::command]
pub async fn send_weather(
    app: tauri::AppHandle,
    state: State<'_, WeatherState>,
    tnc: State<'_, Tnc>,
    callsign: String,
    route: String,
    path: String,
) -> Result<String, String> {
    let obs = state
        .0
        .lock()
        .map_err(|_| "Weather source unavailable")?
        .clone()
        .ok_or("Refresh the weather observation before sending.")?;
    if !fresh(&obs) {
        return Err("Weather observation is too old or its values have not changed for 20 minutes. Refresh it first.".into());
    }
    let body = weather_payload(&obs)?;
    let call = weather_callsign(&callsign)?;
    match route.as_str() {
        "rf" => tnc::send_rf_payload(tnc, call, path, body).await,
        "ip" => {
            let pass = beacon::load_passcode(&app, &call)?;
            tauri::async_runtime::spawn_blocking(move || beacon::transmit(&call, &pass, &body))
                .await
                .map_err(|_| "Weather transmission failed.")?
        }
        _ => Err("Choose APRS-IS or RF.".into()),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn weather_freshness_survives_restart_and_ignores_timestamps_and_missing_fields() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("freshness.json");
        let mut obs = Observation {
            source: "TEST".into(),
            observed_at: 100,
            lat: 42.,
            lon: -83.,
            temperature: Some(50.),
            wind_direction: Some(90.),
            wind_speed: Some(2.),
            wind_gust: None,
            humidity: Some(70.),
            pressure_hpa: Some(1013.),
            source_last_change_at: None,
        };
        update_wu_freshness(&path, &mut obs, 100).unwrap();
        assert_eq!(obs.source_last_change_at, Some(100));
        obs.observed_at = 500;
        obs.wind_direction = None;
        update_wu_freshness(&path, &mut obs, 500).unwrap();
        assert_eq!(obs.source_last_change_at, Some(100));
        // The persisted snapshot is read afresh on every call, as after a restart.
        obs.observed_at = 1300;
        update_wu_freshness(&path, &mut obs, 1300).unwrap();
        assert_eq!(obs.source_last_change_at, Some(100));
        obs.wind_direction = Some(180.);
        // An altered copy with the same observation timestamp is not a new reading.
        update_wu_freshness(&path, &mut obs, 1301).unwrap();
        assert_eq!(obs.source_last_change_at, Some(100));
        obs.observed_at = 1302;
        update_wu_freshness(&path, &mut obs, 1302).unwrap();
        assert_eq!(obs.source_last_change_at, Some(1302));
        obs.observed_at = 1300;
        assert!(update_wu_freshness(&path, &mut obs, 1303).is_err());
    }
    #[test]
    fn weather_uses_base_callsign_with_ssid_13() {
        assert_eq!(weather_callsign("k8oty-1").unwrap(), "K8OTY-13");
        assert_eq!(weather_callsign("K8OTY").unwrap(), "K8OTY-13");
        assert_eq!(weather_callsign("K8OTY-13").unwrap(), "K8OTY-13");
        assert!(weather_callsign("K8OTY-16").is_err());
    }
    #[test]
    fn peet_logging_and_packet_observations() {
        let logging = from_peet("!!00640040FFCE00002794000001F40000012C03E8", 42., -83.).unwrap();
        assert_eq!(logging.temperature, Some(-5.0));
        assert_eq!(logging.wind_direction, Some(90.0));
        assert_eq!(logging.humidity, Some(50.0));
        assert_eq!(logging.pressure_hpa, Some(1013.2));
        assert!((logging.wind_speed.unwrap() - 6.21371).abs() < 0.0001);
        let packet = from_peet(
            "$ULTW002C0007----0000----00000000000002E9006003ED00000004",
            42.,
            -83.,
        )
        .unwrap();
        assert_eq!(packet.temperature, None);
        assert_eq!(packet.wind_direction, None);
        assert!(packet.wind_gust.is_some());
        assert!(from_peet("!!XXXX0040FFCE00002794000001F40000012C03E8", 42., -83.).is_none());
    }
    #[test]
    fn parses_wu_current_conditions() {
        let body = format!(
            r#"{{"observations":[{{"stationID":"KTEST1","epoch":{},"lat":42.0,"lon":-83.0,"winddir":329,"humidity":71,"imperial":{{"temp":53,"windSpeed":2,"windGust":null,"pressure":30.09}}}}]}}"#,
            now()
        );
        let o = from_wu(serde_json::from_str(&body).unwrap(), "KTEST1").unwrap();
        assert_eq!(o.temperature, Some(53.));
        assert_eq!(o.wind_gust, None);
        assert!((o.pressure_hpa.unwrap() - 1018.96).abs() < 0.02);
    }
    #[test]
    fn encodes_weather_without_inventing_rain() {
        let o = Observation {
            source: "TEST".into(),
            observed_at: now(),
            lat: 42.0,
            lon: -83.0,
            temperature: Some(-5.),
            wind_direction: Some(0.),
            wind_speed: Some(3.),
            wind_gust: None,
            humidity: Some(100.),
            pressure_hpa: Some(1013.2),
            source_last_change_at: None,
        };
        assert_eq!(
            weather_payload(&o).unwrap(),
            "!4200.00N/08300.00W_360/003t-05h00b10132"
        );
        assert!(fresh(&o));
        let mut unchanged = o.clone();
        unchanged.source_last_change_at = Some(now() - 1200);
        assert!(!fresh(&unchanged));
        unchanged.source_last_change_at = Some(now() - 1190);
        assert!(fresh(&unchanged));
    }
    #[test]
    fn stale_observations_are_rejected() {
        let data = Wunderground {
            observations: vec![WuObservation {
                station_id: "TEST".into(),
                epoch: now() - 1200,
                lat: 42.,
                lon: -83.,
                winddir: None,
                humidity: None,
                qc_status: None,
                imperial: WuImperial {
                    temp: None,
                    wind_speed: None,
                    wind_gust: None,
                    pressure: None,
                },
            }],
        };
        assert!(from_wu(data, "TEST").is_err());
    }
}
