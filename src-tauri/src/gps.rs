use serde::Serialize;
use std::{
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs, UdpSocket},
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
            || degrees < 0.0
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
fn parse_gpsd(line: &str) -> Option<Fix> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("class")?.as_str()? != "TPV" || !matches!(value.get("mode")?.as_u64()?, 2 | 3) {
        return None;
    }
    let lat = value.get("lat")?.as_f64()?;
    let lon = value.get("lon")?.as_f64()?;
    if !lat.is_finite() || !lon.is_finite() || lat.abs() > 90.0 || lon.abs() > 180.0 {
        return None;
    }
    let speed_knots = value
        .get("speed")
        .and_then(|v| v.as_f64())
        .filter(|v| v.is_finite() && *v >= 0.0 && *v <= 513.9)
        .map(|v| v * 1.943_844_492_440_6);
    let course = value
        .get("track")
        .and_then(|v| v.as_f64())
        .filter(|v| v.is_finite() && (0.0..=360.0).contains(v))
        .map(|v| v % 360.0);
    Some(Fix {
        lat,
        lon,
        speed_knots,
        course,
        received_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_millis() as u64,
    })
}

// Each connection owns its framing buffer; malformed and oversized lines are discarded.
#[derive(Default)]
struct Lines {
    bytes: Vec<u8>,
    discard: bool,
}
impl Lines {
    fn feed(&mut self, chunk: &[u8], gpsd: bool, emit: &mut impl FnMut(Fix)) {
        for &b in chunk {
            if b == b'\n' {
                if !self.discard {
                    if let Ok(text) = std::str::from_utf8(&self.bytes) {
                        let fix = if gpsd {
                            parse_gpsd(text)
                        } else {
                            parse_rmc(text).ok().flatten()
                        };
                        if let Some(fix) = fix {
                            emit(fix);
                        }
                    }
                }
                self.bytes.clear();
                self.discard = false;
            } else if !self.discard && self.bytes.len() < if gpsd { 10240 } else { 1024 } {
                self.bytes.push(b);
            } else {
                self.discard = true;
            }
        }
    }
}

fn read_stream(
    mut reader: impl Read,
    gpsd: bool,
    active: impl Fn() -> bool,
    mut emit: impl FnMut(Fix),
) -> Result<(), String> {
    let mut lines = Lines::default();
    let mut bytes = [0u8; 2048];
    while active() {
        match reader.read(&mut bytes) {
            Ok(0) => return Err("GPS connection closed.".into()),
            Ok(n) => lines.feed(&bytes[..n], gpsd, &mut emit),
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::WouldBlock
                        | std::io::ErrorKind::Interrupted
                ) => {}
            Err(e) => return Err(format!("GPS read failed: {e}")),
        }
    }
    Ok(())
}

fn connect_tcp(endpoint: &str) -> Result<TcpStream, String> {
    let addresses = endpoint
        .to_socket_addrs()
        .map_err(|e| format!("Invalid GPS address: {e}"))?;
    let mut last = None;
    for address in addresses {
        match TcpStream::connect_timeout(&address, Duration::from_secs(5)) {
            Ok(stream) => return Ok(stream),
            Err(error) => last = Some(error),
        }
    }
    Err(format!(
        "Could not connect GPS: {}",
        last.map_or_else(|| "no addresses found".to_string(), |e| e.to_string())
    ))
}

fn subscribe_gpsd(stream: &mut TcpStream) -> Result<(), String> {
    stream
        .write_all(b"?WATCH={\"enable\":true,\"json\":true};\n")
        .map_err(|e| format!("Could not subscribe to gpsd: {e}"))
}

fn read_datagrams(
    socket: UdpSocket,
    active: impl Fn() -> bool,
    mut emit: impl FnMut(Fix),
) -> Result<(), String> {
    let mut bytes = [0u8; 4096];
    while active() {
        match socket.recv_from(&mut bytes) {
            Ok((n, _)) => {
                let mut lines = Lines::default();
                lines.feed(&bytes[..n], false, &mut emit);
                lines.feed(b"\n", false, &mut emit);
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::WouldBlock
                        | std::io::ErrorKind::Interrupted
                ) => {}
            Err(e) => return Err(format!("GPS UDP read failed: {e}")),
        }
    }
    Ok(())
}

#[tauri::command]
pub fn connect_gps(
    app: tauri::AppHandle,
    state: State<'_, Gps>,
    source: String,
    endpoint: String,
    baud: u32,
) -> Result<u64, String> {
    if endpoint.trim().is_empty()
        || endpoint.len() > 512
        || !matches!(source.as_str(), "serial" | "tcp" | "udp" | "gpsd")
        || (source == "serial" && !(300..=921600).contains(&baud))
    {
        return Err("Choose a valid GPS source and address or serial port.".into());
    }
    let generation = state.0.fetch_add(1, Ordering::SeqCst) + 1;
    let token = state.0.clone();
    std::thread::spawn(move || {
        let emit = |status, message: String, fix| {
            let _ = app.emit(
                "gps-status",
                Event {
                    generation,
                    state: status,
                    message,
                    fix,
                },
            );
        };
        emit("connecting", format!("Opening {endpoint}…"), None);
        let active = || token.load(Ordering::SeqCst) == generation;
        let mut report = |fix| {
            if active() {
                emit("fix", "GPS fix".into(), Some(fix));
            }
        };
        let result: Result<(), String> = (|| match source.as_str() {
            "serial" => {
                let serial = serialport::new(&endpoint, baud)
                    .timeout(Duration::from_millis(250))
                    .open()
                    .map_err(|e| format!("Could not open GPS port {endpoint}: {e}"))?;
                if active() {
                    emit(
                        "connected",
                        format!("GPS connected · waiting for valid RMC fix · {endpoint}"),
                        None,
                    );
                }
                read_stream(serial, false, active, &mut report)
            }
            "tcp" | "gpsd" => {
                let mut stream = connect_tcp(&endpoint)?;
                stream
                    .set_read_timeout(Some(Duration::from_millis(250)))
                    .map_err(|e| e.to_string())?;
                stream
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .map_err(|e| e.to_string())?;
                if source == "gpsd" {
                    subscribe_gpsd(&mut stream)?;
                }
                if active() {
                    emit(
                        "connected",
                        format!("GPS connected · waiting for a fix · {endpoint}"),
                        None,
                    );
                }
                read_stream(stream, source == "gpsd", active, &mut report)
            }
            "udp" => {
                let socket = UdpSocket::bind(&endpoint)
                    .map_err(|e| format!("Could not bind GPS UDP address {endpoint}: {e}"))?;
                socket
                    .set_read_timeout(Some(Duration::from_millis(250)))
                    .map_err(|e| e.to_string())?;
                if active() {
                    emit(
                        "connected",
                        format!("Listening for GPS datagrams · {endpoint}"),
                        None,
                    );
                }
                read_datagrams(socket, active, &mut report)
            }
            _ => unreachable!(),
        })();
        if active() {
            if let Err(error) = result {
                emit("error", error, None);
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
    fn gpsd_reports_require_fix_and_convert_motion() {
        let fix =
            parse_gpsd(r#"{"class":"TPV","mode":3,"lat":42.3,"lon":-83.0,"speed":10,"track":360}"#)
                .unwrap();
        assert!((fix.speed_knots.unwrap() - 19.4384449).abs() < 0.00001);
        assert_eq!(fix.course, Some(0.0));
        assert!(parse_gpsd(r#"{"class":"TPV","mode":1,"lat":42,"lon":-83}"#).is_none());
        assert!(parse_gpsd(r#"{"class":"TPV","mode":2,"lat":91,"lon":0}"#).is_none());
        assert!(parse_gpsd(r#"{"class":"SKY","mode":3}"#).is_none());
    }

    #[test]
    fn tcp_stream_handles_fragmented_sentences_and_disconnect() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut peer, _) = listener.accept().unwrap();
            let line = sentence("GNRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,,");
            peer.write_all(&line.as_bytes()[..12]).unwrap();
            peer.write_all(&line.as_bytes()[12..]).unwrap();
            peer.write_all(b"\r\n").unwrap();
        });
        let stream = connect_tcp(&address.to_string()).unwrap();
        let mut fixes = Vec::new();
        let result = read_stream(stream, false, || true, |fix| fixes.push(fix));
        server.join().unwrap();
        assert!(result.is_err());
        assert_eq!(fixes.len(), 1);
        assert!((fixes[0].lat - 48.1173).abs() < 1e-6);
    }

    #[test]
    fn gpsd_subscription_and_stream_are_accepted() {
        use std::io::BufRead;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut peer, _) = listener.accept().unwrap();
            let mut command = String::new();
            std::io::BufReader::new(&mut peer)
                .read_line(&mut command)
                .unwrap();
            assert_eq!(command, "?WATCH={\"enable\":true,\"json\":true};\n");
            peer.write_all(b"{\"class\":\"TPV\",\"mode\":3,\"lat\":42.3,\"lon\":-83.0,\"speed\":10,\"track\":90}\n").unwrap();
        });
        let mut stream = connect_tcp(&address.to_string()).unwrap();
        subscribe_gpsd(&mut stream).unwrap();
        let mut fixes = Vec::new();
        let _ = read_stream(stream, true, || true, |fix| fixes.push(fix));
        server.join().unwrap();
        assert_eq!(fixes.len(), 1);
        assert_eq!(fixes[0].lat, 42.3);
    }

    #[test]
    fn udp_datagram_without_newline_is_accepted() {
        let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
        socket
            .set_read_timeout(Some(Duration::from_millis(100)))
            .unwrap();
        let address = socket.local_addr().unwrap();
        let sender = UdpSocket::bind("127.0.0.1:0").unwrap();
        let line = sentence("GNRMC,123519,A,4807.038,N,01131.000,E,0,0,230394,,");
        sender.send_to(line.as_bytes(), address).unwrap();
        let running = std::cell::Cell::new(true);
        let mut fixes = Vec::new();
        read_datagrams(
            socket,
            || running.get(),
            |fix| {
                fixes.push(fix);
                running.set(false);
            },
        )
        .unwrap();
        assert_eq!(fixes.len(), 1);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn virtual_serial_port_receives_rmc() {
        use std::os::fd::FromRawFd;
        let mut master = -1;
        let mut slave = -1;
        assert_eq!(
            unsafe {
                libc::openpty(
                    &mut master,
                    &mut slave,
                    std::ptr::null_mut(),
                    std::ptr::null(),
                    std::ptr::null(),
                )
            },
            0
        );
        let path = std::fs::read_link(format!("/proc/self/fd/{slave}")).unwrap();
        let port = serialport::new(path.to_str().unwrap(), 9600)
            .timeout(Duration::from_secs(2))
            .open()
            .unwrap();
        unsafe {
            libc::close(slave);
        }
        let writer = std::thread::spawn(move || {
            let mut file = unsafe { std::fs::File::from_raw_fd(master) };
            let line = sentence("GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,,");
            file.write_all(format!("{line}\r\n").as_bytes()).unwrap();
            std::thread::sleep(Duration::from_millis(100));
        });
        let mut fixes = Vec::new();
        let _ = read_stream(port, false, || true, |fix| fixes.push(fix));
        writer.join().unwrap();
        assert_eq!(fixes.len(), 1);
        assert!((fixes[0].lon - 11.5166667).abs() < 1e-6);
    }

    #[test]
    fn framing_recovers_from_oversized_and_invalid_lines() {
        let mut lines = Lines::default();
        let mut fixes = Vec::new();
        lines.feed(&vec![b'x'; 1100], false, &mut |fix| fixes.push(fix));
        let line = sentence("GNRMC,123519,A,4807.038,N,01131.000,E,0,0,230394,,");
        lines.feed(
            format!("\n$bad*00\n{line}\n").as_bytes(),
            false,
            &mut |fix| fixes.push(fix),
        );
        assert_eq!(fixes.len(), 1);
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
