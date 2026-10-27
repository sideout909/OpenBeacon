use openbeacon_packet::{
    aprs::{decode_rf_frame, decode_tnc2, DecodedPacket, PacketOrigin},
    ax25::KissDecoder,
};
use serde::Serialize;
use std::{
    io::Read,
    net::{SocketAddr, TcpStream},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{Emitter, Manager, State};

#[derive(Default)]
pub struct Tnc(Arc<AtomicU64>);
#[derive(Clone, Serialize)]
struct Status {
    generation: u64,
    state: &'static str,
    message: String,
    received: u64,
    errors: u64,
}
#[derive(Clone, Serialize)]
struct Batch {
    generation: u64,
    packets: Vec<DecodedPacket>,
}
fn report(
    app: &tauri::AppHandle,
    generation: u64,
    state: &'static str,
    message: String,
    received: u64,
    errors: u64,
) {
    let _ = app.emit(
        "tnc-status",
        Status {
            generation,
            state,
            message,
            received,
            errors,
        },
    );
}
fn active(token: &AtomicU64, generation: u64) -> bool {
    token.load(Ordering::SeqCst) == generation
}
fn decode_kiss_bytes(
    decoder: &mut KissDecoder,
    input: &[u8],
    interface: &str,
) -> (Vec<DecodedPacket>, u64) {
    let mut packets = Vec::new();
    let mut errors = 0;
    for frame in decoder.feed(input) {
        match frame.and_then(|f| {
            decode_rf_frame(&f.bytes, false).map(|(_, mut packet)| {
                packet.kiss_port = Some(f.port);
                packet.source_interface = Some(interface.to_owned());
                packet
            })
        }) {
            Ok(packet) => packets.push(packet),
            Err(_) => errors += 1,
        }
    }
    (packets, errors)
}
#[tauri::command]
pub fn connect_tnc(
    app: tauri::AppHandle,
    state: State<'_, Tnc>,
    endpoint: String,
    managed: bool,
) -> Result<u64, String> {
    let addr: SocketAddr = endpoint
        .parse()
        .map_err(|_| "Enter an IP address and port, such as 127.0.0.1:8001.".to_string())?;
    let generation = state.0.fetch_add(1, Ordering::SeqCst) + 1;
    let token = state.0.clone();
    std::thread::spawn(move || {
        let (mut received, mut errors, mut retry) = (0, 0, 1);
        while active(&token, generation) {
            let exited = app
                .state::<Modem>()
                .0
                .lock()
                .ok()
                .and_then(|mut child| child.as_mut().and_then(|p| p.try_wait().ok().flatten()))
                .is_some();
            if managed && exited {
                report(&app, generation, "stopped", "Dire Wolf exited. Check direwolf.log in the OpenBeacon configuration directory.".into(), received, errors);
                break;
            }
            report(
                &app,
                generation,
                "connecting",
                format!("Connecting to {addr}…"),
                received,
                errors,
            );
            match TcpStream::connect_timeout(&addr, Duration::from_secs(3)) {
                Ok(mut stream) => {
                    if !active(&token, generation) {
                        break;
                    }
                    let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
                    report(
                        &app,
                        generation,
                        "connected",
                        format!("Receive-only KISS · {addr}"),
                        received,
                        errors,
                    );
                    retry = 1;
                    let mut decoder = KissDecoder::default();
                    let mut buf = [0; 4096];
                    while active(&token, generation) {
                        match stream.read(&mut buf) {
                            Ok(0) => break,
                            Ok(n) => {
                                let interface = if managed {
                                    "Dire Wolf".to_string()
                                } else {
                                    format!("TCP KISS {addr}")
                                };
                                let (packets, bad) =
                                    decode_kiss_bytes(&mut decoder, &buf[..n], &interface);
                                received += packets.len() as u64;
                                errors += bad;
                                if !packets.is_empty() && active(&token, generation) {
                                    if let Err(error) = crate::history::save(&app, &packets) {
                                        let _ = app.emit("history-error", error);
                                    }
                                    let _ = app.emit(
                                        "tnc-packets",
                                        Batch {
                                            generation,
                                            packets,
                                        },
                                    );
                                }
                                report(
                                    &app,
                                    generation,
                                    "connected",
                                    format!("Receive-only KISS · {addr}"),
                                    received,
                                    errors,
                                );
                            }
                            Err(e)
                                if matches!(
                                    e.kind(),
                                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                                ) => {}
                            Err(_) => break,
                        }
                    }
                }
                Err(e) => report(
                    &app,
                    generation,
                    "error",
                    format!("Connection failed: {e}"),
                    received,
                    errors,
                ),
            }
            if active(&token, generation) {
                report(
                    &app,
                    generation,
                    "reconnecting",
                    format!("Reconnecting in {retry}s · {addr}"),
                    received,
                    errors,
                );
                for _ in 0..retry * 4 {
                    if !active(&token, generation) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
                retry = (retry * 2).min(30);
            }
        }
    });
    Ok(generation)
}
#[derive(Serialize)]
pub struct SerialDevice {
    id: String,
    name: String,
}
#[tauri::command]
pub fn list_serial_devices() -> Result<Vec<SerialDevice>, String> {
    let ports = serialport::available_ports().map_err(|e| e.to_string())?;
    let mut devices: Vec<_> = ports
        .into_iter()
        .map(|port| {
            let name = match port.port_type {
                serialport::SerialPortType::UsbPort(info) => format!(
                    "{} · {}",
                    info.product.unwrap_or_else(|| "USB serial".into()),
                    port.port_name
                ),
                _ => port.port_name.clone(),
            };
            SerialDevice {
                id: port.port_name,
                name,
            }
        })
        .collect();
    #[cfg(target_os = "linux")]
    if let Ok(entries) = std::fs::read_dir("/dev/serial/by-id") {
        for entry in entries.flatten() {
            let path = entry.path();
            let resolved = std::fs::canonicalize(&path).ok();
            if let Some(item) = devices
                .iter_mut()
                .find(|p| std::fs::canonicalize(&p.id).ok() == resolved && resolved.is_some())
            {
                item.name = format!("{} · {}", entry.file_name().to_string_lossy(), item.name);
                item.id = path.to_string_lossy().into_owned();
            }
        }
    }
    devices.sort_by(|a, b| {
        let a_usb = a.id.contains("/dev/serial/by-id/")
            || a.id.contains("ttyUSB")
            || a.id.contains("ttyACM");
        let b_usb = b.id.contains("/dev/serial/by-id/")
            || b.id.contains("ttyUSB")
            || b.id.contains("ttyACM");
        b_usb.cmp(&a_usb).then_with(|| a.name.cmp(&b.name))
    });
    Ok(devices)
}
#[derive(Default)]
struct MonitorDecoder {
    pending: Vec<u8>,
    oversized: bool,
}
impl MonitorDecoder {
    fn feed(&mut self, input: &[u8], interface: &str) -> (Vec<DecodedPacket>, u64) {
        let mut packets = Vec::new();
        let mut errors = 0;
        for &byte in input {
            if byte == b'\r' || byte == b'\n' {
                if self.oversized {
                    errors += 1;
                } else if !self.pending.is_empty() {
                    let text = std::mem::take(&mut self.pending);
                    let mut stripped = text.as_slice();
                    while stripped.starts_with(b"cmd:") {
                        stripped = &stripped[4..];
                    }
                    while stripped.first().is_some_and(u8::is_ascii_whitespace) {
                        stripped = &stripped[1..];
                    }
                    if stripped.is_empty() {
                        continue;
                    }
                    let mut packet = decode_tnc2(stripped);
                    packet.raw = String::from_utf8_lossy(&text).into_owned();
                    packet.raw_bytes = text;
                    packet.source_interface = Some(interface.to_string());
                    packet.warnings.push(
                        "TNC monitor text; original AX.25 bytes and FCS are unavailable.".into(),
                    );
                    if !packet.source.is_empty()
                        && !packet.destination.is_empty()
                        && packet.kind != "invalid"
                    {
                        packet.origin = PacketOrigin::Rf;
                    } else {
                        packet.origin = PacketOrigin::Unknown;
                        packet.kind = "tnc_monitor_text".into();
                        packet.source.clear();
                        packet.destination.clear();
                        packet.position = None;
                        packet.message = None;
                        packet.weather = None;
                    }
                    packets.push(packet);
                }
                self.pending.clear();
                self.oversized = false;
            } else if !self.oversized && self.pending.len() < 2048 {
                self.pending.push(byte);
            } else {
                self.oversized = true;
            }
        }
        (packets, errors)
    }
}
#[tauri::command]
pub fn connect_serial_tnc(
    app: tauri::AppHandle,
    state: State<'_, Tnc>,
    port: String,
    baud: u32,
    flow: String,
    mode: String,
) -> Result<u64, String> {
    if port.trim().is_empty()
        || port.len() > 512
        || !(300..=921600).contains(&baud)
        || !matches!(flow.as_str(), "none" | "hardware" | "software")
        || !matches!(mode.as_str(), "kiss" | "kenwood")
    {
        return Err("Choose a serial port, baud rate, and valid flow control.".into());
    }
    let flow_control = match flow.as_str() {
        "hardware" => serialport::FlowControl::Hardware,
        "software" => serialport::FlowControl::Software,
        _ => serialport::FlowControl::None,
    };
    let generation = state.0.fetch_add(1, Ordering::SeqCst) + 1;
    let token = state.0.clone();
    std::thread::spawn(move || {
        let (mut received, mut errors, mut retry) = (0, 0, 1);
        while active(&token, generation) {
            report(
                &app,
                generation,
                "connecting",
                format!("Opening {port}…"),
                received,
                errors,
            );
            match serialport::new(&port, baud)
                .data_bits(serialport::DataBits::Eight)
                .parity(serialport::Parity::None)
                .stop_bits(serialport::StopBits::One)
                .flow_control(flow_control)
                .timeout(Duration::from_millis(250))
                .open()
            {
                Ok(mut stream) => {
                    if !active(&token, generation) {
                        break;
                    }
                    retry = 1;
                    report(
                        &app,
                        generation,
                        "connected",
                        format!(
                            "Serial open · waiting for {} · {port} · {baud} baud",
                            if mode == "kiss" {
                                "KISS frames"
                            } else {
                                "TNC monitor text"
                            }
                        ),
                        received,
                        errors,
                    );
                    let mut decoder = KissDecoder::default();
                    let mut monitor = MonitorDecoder::default();
                    let mut buf = [0u8; 4096];
                    while active(&token, generation) {
                        match stream.read(&mut buf) {
                            Ok(0) => {}
                            Ok(n) => {
                                let (packets, bad) = if mode == "kiss" {
                                    decode_kiss_bytes(
                                        &mut decoder,
                                        &buf[..n],
                                        &format!("Serial KISS {port}"),
                                    )
                                } else {
                                    monitor.feed(&buf[..n], &format!("Kenwood TNC monitor {port}"))
                                };
                                received += packets.len() as u64;
                                errors += bad;
                                if !packets.is_empty() && active(&token, generation) {
                                    if let Err(error) = crate::history::save(&app, &packets) {
                                        let _ = app.emit("history-error", error);
                                    }
                                    let _ = app.emit(
                                        "tnc-packets",
                                        Batch {
                                            generation,
                                            packets,
                                        },
                                    );
                                }
                                report(
                                    &app,
                                    generation,
                                    "connected",
                                    format!(
                                        "Serial open · waiting for {} · {port} · {baud} baud",
                                        if mode == "kiss" {
                                            "KISS frames"
                                        } else {
                                            "TNC monitor text"
                                        }
                                    ),
                                    received,
                                    errors,
                                );
                            }
                            Err(e)
                                if matches!(
                                    e.kind(),
                                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                                ) => {}
                            Err(e) => {
                                report(
                                    &app,
                                    generation,
                                    "error",
                                    format!("Serial read failed: {e}"),
                                    received,
                                    errors,
                                );
                                break;
                            }
                        }
                    }
                }
                Err(e) => report(
                    &app,
                    generation,
                    "error",
                    format!("Could not open {port}: {e}"),
                    received,
                    errors,
                ),
            }
            if active(&token, generation) {
                report(
                    &app,
                    generation,
                    "reconnecting",
                    format!("Reconnecting to {port} in {retry}s"),
                    received,
                    errors,
                );
                for _ in 0..retry * 4 {
                    if !active(&token, generation) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
                retry = (retry * 2).min(30);
            }
        }
    });
    Ok(generation)
}
pub fn shutdown(app: &tauri::AppHandle) {
    app.state::<Tnc>().0.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut child) = app.state::<Modem>().0.lock() {
        stop_owned(&mut child);
    }
}
#[tauri::command]
pub fn disconnect_tnc(state: State<'_, Tnc>) {
    state.0.fetch_add(1, Ordering::SeqCst);
}

fn stop_owned(child: &mut Option<std::process::Child>) {
    if let Some(mut process) = child.take() {
        let _ = process.kill();
        let _ = process.wait();
    }
}
#[derive(Default)]
pub struct Modem(std::sync::Mutex<Option<std::process::Child>>);
impl Drop for Modem {
    fn drop(&mut self) {
        if let Ok(child) = self.0.get_mut() {
            stop_owned(child);
        }
    }
}
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn stage_modem(
    binary: &std::path::Path,
    dir: &std::path::Path,
) -> Result<tempfile::TempPath, String> {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    let mut copy = tempfile::Builder::new()
        .prefix("openbeacon-direwolf-")
        .tempfile_in(dir)
        .map_err(|e| format!("Could not prepare Dire Wolf: {e}"))?;
    let mut input = std::fs::File::open(binary).map_err(|e| e.to_string())?;
    std::io::copy(&mut input, &mut copy).map_err(|e| e.to_string())?;
    copy.flush().map_err(|e| e.to_string())?;
    copy.as_file()
        .set_permissions(std::fs::Permissions::from_mode(0o700))
        .map_err(|e| e.to_string())?;
    Ok(copy.into_temp_path())
}
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn spawn_staged(command: &mut std::process::Command) -> std::io::Result<std::process::Child> {
    for attempt in 0..5 {
        match command.spawn() {
            Err(error) if error.raw_os_error() == Some(libc::ETXTBSY) && attempt < 4 => {
                std::thread::sleep(Duration::from_millis(20))
            }
            result => return result,
        }
    }
    unreachable!()
}
#[tauri::command]
pub fn start_direwolf(
    app: tauri::AppHandle,
    state: State<'_, Modem>,
    audio_device: String,
) -> Result<(), String> {
    let device = audio_device.trim();
    if device.is_empty()
        || device.len() > 100
        || !device
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-,:.=".contains(&b))
    {
        return Err("Enter an ALSA device name such as default or plughw:1,0.".into());
    }
    let mut child = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(process) = child.as_mut() {
        if process.try_wait().map_err(|e| e.to_string())?.is_none() {
            return Err("Dire Wolf is already running in OpenBeacon.".into());
        }
    }
    let listener = std::net::TcpListener::bind("127.0.0.1:8001").map_err(|_| {
        "Port 8001 is in use. Stop the other KISS service before starting the bundled modem."
            .to_string()
    })?;
    drop(listener);
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let config = dir.join("direwolf-receive.conf");
    std::fs::write(&config, format!("ADEVICE {device} null\nACHANNELS 1\nCHANNEL 0\nMYCALL N0CALL\nMODEM 1200\nFIX_BITS 1 APRS\nAGWPORT 0\nKISSPORT 8001\n")).map_err(|e| e.to_string())?;
    let log_path = dir.join("direwolf.log");
    let log = std::fs::File::create(&log_path).map_err(|e| e.to_string())?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;
    let resource = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("direwolf-linux-x86_64");
    let dev =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/direwolf-linux-x86_64");
    let binary = if resource.is_file() { resource } else { dev };
    #[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
    return Err("Bundled Dire Wolf is not available for this platform yet.".into());
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        use std::os::unix::process::CommandExt;
        // Run a private unlinked copy so Tauri can update the bundled resource.
        let executable = stage_modem(&binary, &dir)?;
        let parent = std::process::id();
        let mut command = std::process::Command::new(&executable);
        command
            .arg("-c")
            .arg(config)
            .arg("-t")
            .arg("0")
            .stdin(std::process::Stdio::null())
            .stdout(log)
            .stderr(log_err);
        // Linux delivers SIGKILL if the owning OpenBeacon process exits or crashes.
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::getppid() as u32 != parent {
                    return Err(std::io::Error::other(
                        "OpenBeacon exited during modem startup",
                    ));
                }
                Ok(())
            });
        }
        let mut process = spawn_staged(&mut command)
            .map_err(|e| format!("Could not start bundled Dire Wolf: {e}"))?;
        drop(executable);
        std::thread::sleep(Duration::from_millis(800));
        if process.try_wait().map_err(|e| e.to_string())?.is_some() {
            return Err(format!(
                "Dire Wolf exited during startup. Check {}",
                log_path.display()
            ));
        }
        *child = Some(process);
        Ok(())
    }
}
#[tauri::command]
pub fn stop_direwolf(state: State<'_, Modem>) -> Result<(), String> {
    let mut child = state.0.lock().map_err(|e| e.to_string())?;
    stop_owned(&mut child);
    Ok(())
}

#[derive(Serialize)]
pub struct CaptureDevice {
    id: String,
    name: String,
}
fn parse_capture_devices(pcm: &str, cards: &str) -> Vec<CaptureDevice> {
    let mut devices = Vec::new();
    for line in pcm.lines().filter(|line| line.contains("capture ")) {
        let Some((id, description)) = line.split_once(':') else {
            continue;
        };
        let Some((card, dev)) = id.trim().split_once('-') else {
            continue;
        };
        let (Ok(card_num), Ok(dev_num)) = (card.parse::<u32>(), dev.parse::<u32>()) else {
            continue;
        };
        let card_id = cards.lines().find_map(|line| {
            let (prefix, rest) = line.trim().split_once('[')?;
            if prefix.trim().parse::<u32>().ok()? != card_num {
                return None;
            }
            let name = rest.split_once(']')?.0.trim();
            if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
                return None;
            }
            Some(name)
        });
        let card_name = cards
            .lines()
            .find_map(|line| {
                let (prefix, rest) = line.trim().split_once('[')?;
                if prefix.trim().parse::<u32>().ok()? != card_num {
                    return None;
                }
                Some(rest.split_once(": ")?.1.split_once(" - ")?.1.trim())
            })
            .unwrap_or("Audio device");
        let input_name = description.split(':').next().unwrap_or("").trim();
        let device_id = card_id
            .map(|id| format!("plughw:CARD={id},DEV={dev_num}"))
            .unwrap_or_else(|| format!("plughw:{card_num},{dev_num}"));
        devices.push(CaptureDevice {
            id: device_id,
            name: format!("{card_name} — {input_name}"),
        });
    }
    devices
}
#[tauri::command]
pub fn list_capture_devices() -> Result<Vec<CaptureDevice>, String> {
    #[cfg(target_os = "linux")]
    {
        let pcm = std::fs::read_to_string("/proc/asound/pcm")
            .map_err(|e| format!("Could not list ALSA capture devices: {e}"))?;
        let cards = std::fs::read_to_string("/proc/asound/cards").unwrap_or_default();
        Ok(parse_capture_devices(&pcm, &cards))
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err("Audio device discovery is not available on this platform yet.".into())
    }
}
#[cfg(test)]
mod capture_tests {
    use super::*;
    #[test]
    fn native_monitor_preserves_text_and_decodes_only_complete_tnc2_lines() {
        let mut monitor = MonitorDecoder::default();
        assert!(monitor.feed(b"N0ABC>APRS:!4230.", "Kenwood").0.is_empty());
        let (packets, errors) = monitor.feed(
            b"00N/08306.00W>Test\rcmd: MONITOR ON\r\ncmd:cmd:N0ABC>APRS:!4230.00N/08306.00W>Test\r",
            "Kenwood",
        );
        assert_eq!(errors, 0);
        assert_eq!(packets.len(), 3);
        assert_eq!(packets[0].origin, PacketOrigin::Rf);
        assert_eq!(packets[0].source, "N0ABC");
        assert!(packets[0].position.is_some());
        assert!(packets[0].ax25_bytes.is_none());
        assert_eq!(packets[1].kind, "tnc_monitor_text");
        assert_eq!(packets[1].origin, PacketOrigin::Unknown);
        assert_eq!(packets[2].source, "N0ABC");
        assert!(packets[2].raw.starts_with("cmd:cmd:"));
    }
    #[cfg(unix)]
    #[test]
    fn serial_kiss_fragmented_frame_decodes_without_host_writes() {
        use serialport::SerialPort;
        use std::io::{Read, Write};
        let (mut master, mut slave) = serialport::TTYPort::pair().unwrap();
        master.set_timeout(Duration::from_millis(100)).unwrap();
        slave.set_timeout(Duration::from_millis(100)).unwrap();
        fn address(call: &str, last: bool) -> Vec<u8> {
            let mut out: Vec<u8> = format!("{call:<6}").bytes().map(|b| b << 1).collect();
            out.push(if last { 0x61 } else { 0x60 });
            out
        }
        let mut frame = address("APRS", false);
        frame.extend(address("N0ABC", true));
        frame.extend_from_slice(b"\x03\xf0!4230.00N/08306.00W>Test");
        let kiss = openbeacon_packet::ax25::encode_kiss(2, &frame).unwrap();
        let mut decoder = KissDecoder::default();
        let mut received = Vec::new();
        for chunk in kiss.chunks(5) {
            master.write_all(chunk).unwrap();
            let mut buf = [0u8; 64];
            let n = slave.read(&mut buf).unwrap();
            let (packets, errors) = decode_kiss_bytes(&mut decoder, &buf[..n], "Serial KISS test");
            assert_eq!(errors, 0);
            received.extend(packets);
        }
        assert_eq!(received.len(), 1);
        assert_eq!(received[0].source, "N0ABC");
        assert_eq!(received[0].kiss_port, Some(2));
        assert_eq!(received[0].ax25_bytes.as_deref(), Some(frame.as_slice()));
        assert!(received[0].position.is_some());
        let mut buf = [0u8; 1];
        assert!(master.read(&mut buf).is_err());
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    #[test]
    fn staged_executable_does_not_lock_bundled_file() {
        let dir = tempfile::tempdir().unwrap();
        let bundled = dir.path().join("modem");
        std::fs::copy("/bin/sleep", &bundled).unwrap();
        let staged = stage_modem(&bundled, dir.path()).unwrap();
        let mut command = std::process::Command::new(&staged);
        command.arg("30");
        let mut child = spawn_staged(&mut command).unwrap();
        drop(staged);
        std::fs::write(&bundled, b"replacement").unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn stopping_owned_process_is_idempotent() {
        let child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let mut owned = Some(child);
        stop_owned(&mut owned);
        assert!(owned.is_none());
        stop_owned(&mut owned);
    }
    #[test]
    fn capture_listing_excludes_playback_and_uses_stable_card_id() {
        let devices = parse_capture_devices("00-03: HDMI : HDMI : playback 1\n01-00: USB Audio : USB Audio : playback 1 : capture 1\n", " 1 [Device         ]: USB-Audio - USB PnP Sound Device\n");
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].id, "plughw:CARD=Device,DEV=0");
        assert_eq!(devices[0].name, "USB PnP Sound Device — USB Audio");
    }
}
