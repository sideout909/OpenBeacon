//! Opt-in, one-way RF to APRS-IS gateway. Never consumes history or internet packets.
use openbeacon_packet::aprs::{DecodedPacket, PacketOrigin};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpStream, ToSocketAddrs},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, SyncSender},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, State};

type PacketSender = Mutex<Option<(u64, SyncSender<DecodedPacket>)>>;

#[derive(Default)]
pub struct Igate {
    generation: Arc<AtomicU64>,
    sender: Arc<PacketSender>,
}
#[derive(Clone, Serialize)]
struct Status {
    generation: u64,
    state: &'static str,
    message: String,
    forwarded: u64,
    skipped: u64,
}
fn report(
    app: &tauri::AppHandle,
    generation: u64,
    state: &'static str,
    message: &str,
    forwarded: u64,
    skipped: u64,
) {
    let _ = app.emit(
        "igate-status",
        Status {
            generation,
            state,
            message: message.into(),
            forwarded,
            skipped,
        },
    );
}
fn valid_call(call: &str) -> bool {
    let mut parts = call.split('-');
    let base = parts.next().unwrap_or("");
    (3..=6).contains(&base.len())
        && base
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
        && parts.next().is_none_or(|s| {
            !s.is_empty()
                && s.len() <= 2
                && s.bytes().all(|b| b.is_ascii_digit())
                && s.parse::<u8>().is_ok_and(|n| n <= 15)
        })
        && parts.next().is_none()
}
fn format_packet(packet: &DecodedPacket, call: &str) -> Option<(Vec<u8>, Vec<u8>)> {
    if packet.origin != PacketOrigin::Rf {
        return None;
    }
    // KISS supplies the AX.25 control and PID; text monitor mode cannot prove these.
    let frame = packet.ax25_bytes.as_ref()?;
    let mut offset = 0;
    loop {
        let addr = frame.get(offset..offset + 7)?;
        offset += 7;
        if addr[6] & 1 != 0 {
            break;
        }
        if offset > 70 {
            return None;
        }
    }
    if frame.get(offset..offset + 2)? != [0x03, 0xf0] {
        return None;
    }
    fn parse(raw: &[u8]) -> Option<(&[u8], &[u8], &[u8])> {
        let colon = raw.iter().position(|&b| b == b':')?;
        let header = &raw[..colon];
        let body = raw.get(colon + 1..)?;
        let gt = header.iter().position(|&b| b == b'>')?;
        if gt == 0
            || gt + 1 == header.len()
            || body.is_empty()
            || !header.iter().all(|b| (33..=126).contains(b))
            || body.iter().any(|b| *b == 0 || *b == b'\r' || *b == b'\n')
        {
            return None;
        }
        let parts: Vec<_> = header[gt + 1..].split(|b| *b == b',').collect();
        if parts.iter().any(|p| p.is_empty()) {
            return None;
        }
        for part in parts.iter().skip(1) {
            let p = String::from_utf8_lossy(part)
                .trim_end_matches('*')
                .to_ascii_uppercase();
            if matches!(p.as_str(), "TCPIP" | "TCPXX" | "NOGATE" | "RFONLY")
                || p.starts_with('Q') && p.len() == 3
            {
                return None;
            }
        }
        Some((header, &header[..gt], body))
    }
    let (mut header, _, mut body) = parse(&packet.raw_bytes)?;
    if body[0] == b'}' {
        (header, _, body) = parse(&body[1..])?;
        if body[0] == b'}' {
            return None;
        }
    }
    if body[0] == b'?' {
        return None;
    }
    let gt = header.iter().position(|&b| b == b'>')?;
    if header[..gt].eq_ignore_ascii_case(call.as_bytes()) {
        return None;
    }
    let dest_end = header[gt + 1..]
        .iter()
        .position(|&b| b == b',')
        .map(|n| gt + 1 + n)
        .unwrap_or(header.len());
    let mut key = header[..dest_end].to_ascii_uppercase();
    key.push(b':');
    key.extend_from_slice(body);
    let mut line = header.to_vec();
    line.extend_from_slice(format!(",qAO,{call}:").as_bytes());
    line.extend_from_slice(body);
    line.extend_from_slice(b"\r\n");
    (line.len() <= 512).then_some((key, line))
}
pub fn offer(app: &tauri::AppHandle, packets: &[DecodedPacket]) {
    let state = app.state::<Igate>();
    if let Ok(guard) = state.sender.lock() {
        if let Some((_, sender)) = guard.as_ref() {
            for packet in packets {
                let _ = sender.try_send(packet.clone());
            }
        }
    };
}
fn clear_sender(sender: &PacketSender, generation: u64) {
    if let Ok(mut guard) = sender.lock() {
        if guard.as_ref().is_some_and(|v| v.0 == generation) {
            *guard = None;
        }
    }
}
fn authenticate(mut stream: TcpStream, call: &str, pass: &str) -> Result<TcpStream, String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(8)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(8)))
        .map_err(|e| e.to_string())?;
    write!(
        stream,
        "user {call} pass {pass} vers OpenBeacon {}\r\n",
        env!("CARGO_PKG_VERSION")
    )
    .map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    for _ in 0..20 {
        let mut line = String::new();
        if reader
            .by_ref()
            .take(1024)
            .read_line(&mut line)
            .map_err(|e| e.to_string())?
            == 0
        {
            break;
        }
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.first() == Some(&"#") && fields.get(1) == Some(&"logresp") {
            if fields.get(2).is_some_and(|v| v.eq_ignore_ascii_case(call))
                && fields
                    .get(3)
                    .is_some_and(|v| v.trim_end_matches(',').eq_ignore_ascii_case("verified"))
            {
                return Ok(stream);
            }
            return Err("APRS-IS did not verify your callsign and passcode.".into());
        }
    }
    Err("APRS-IS did not verify the login.".into())
}
#[tauri::command]
pub fn start_igate(
    app: tauri::AppHandle,
    state: State<'_, Igate>,
    callsign: String,
) -> Result<u64, String> {
    let call = callsign.trim().to_ascii_uppercase();
    if !valid_call(&call) {
        return Err("Enter a valid iGate callsign and optional SSID.".into());
    }
    let pass = crate::beacon::load_passcode(&app, &call)?;
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    if let Ok(mut guard) = state.sender.lock() {
        *guard = None;
    }
    let token = state.generation.clone();
    let sender = state.sender.clone();
    std::thread::spawn(move || {
        let mut forwarded = 0;
        let mut skipped = 0;
        let mut seen = HashMap::<Vec<u8>, Instant>::new();
        while token.load(Ordering::SeqCst) == generation {
            report(
                &app,
                generation,
                "connecting",
                "Connecting to APRS-IS…",
                forwarded,
                skipped,
            );
            let connected = (|| -> Result<TcpStream, String> {
                let address = ("rotate.aprs2.net", 14580)
                    .to_socket_addrs()
                    .map_err(|e| e.to_string())?
                    .next()
                    .ok_or("Could not resolve APRS-IS")?;
                let stream = TcpStream::connect_timeout(&address, Duration::from_secs(8))
                    .map_err(|e| e.to_string())?;
                authenticate(stream, &call, &pass)
            })();
            if token.load(Ordering::SeqCst) != generation {
                break;
            }
            match connected {
                Ok(mut stream) => {
                    let _ = stream.set_read_timeout(Some(Duration::from_millis(100)));
                    let (tx, rx) = mpsc::sync_channel(128);
                    if let Ok(mut guard) = sender.lock() {
                        if token.load(Ordering::SeqCst) == generation {
                            *guard = Some((generation, tx));
                        }
                    }
                    report(
                        &app,
                        generation,
                        "connected",
                        "Verified · forwarding eligible live RF packets",
                        forwarded,
                        skipped,
                    );
                    loop {
                        if token.load(Ordering::SeqCst) != generation {
                            break;
                        }
                        match rx.recv_timeout(Duration::from_millis(100)) {
                            Ok(packet) => {
                                let Some((key, line)) = format_packet(&packet, &call) else {
                                    skipped += 1;
                                    continue;
                                };
                                let now = Instant::now();
                                seen.retain(|_, t| {
                                    now.duration_since(*t) < Duration::from_secs(30)
                                });
                                if seen.contains_key(&key) {
                                    skipped += 1;
                                    continue;
                                }
                                if seen.len() >= 2048 {
                                    seen.clear();
                                }
                                if token.load(Ordering::SeqCst) != generation
                                    || stream.write_all(&line).is_err()
                                {
                                    break;
                                }
                                seen.insert(key, now);
                                forwarded += 1;
                                report(
                                    &app,
                                    generation,
                                    "connected",
                                    "Verified · forwarding eligible live RF packets",
                                    forwarded,
                                    skipped,
                                );
                            }
                            Err(mpsc::RecvTimeoutError::Disconnected) => break,
                            Err(mpsc::RecvTimeoutError::Timeout) => {}
                        }
                        let mut buf = [0; 2048];
                        match stream.read(&mut buf) {
                            Ok(0) => break,
                            Ok(_) => {}
                            Err(e)
                                if matches!(
                                    e.kind(),
                                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                                ) => {}
                            Err(_) => break,
                        }
                    }
                    clear_sender(&sender, generation);
                    if token.load(Ordering::SeqCst) == generation {
                        report(
                            &app,
                            generation,
                            "reconnecting",
                            "APRS-IS disconnected; reconnecting. RF packets are not queued.",
                            forwarded,
                            skipped,
                        );
                    }
                }
                Err(e) => {
                    report(
                        &app,
                        generation,
                        "reconnecting",
                        &format!("{e} Retrying; RF packets are not queued."),
                        forwarded,
                        skipped,
                    );
                }
            }
            for _ in 0..50 {
                if token.load(Ordering::SeqCst) != generation {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        clear_sender(&sender, generation);
    });
    Ok(generation)
}
#[tauri::command]
pub fn stop_igate(state: State<'_, Igate>) {
    state.generation.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut sender) = state.sender.lock() {
        *sender = None;
    }
}
pub fn shutdown(app: &tauri::AppHandle) {
    stop_igate(app.state::<Igate>());
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbeacon_packet::aprs::decode_tnc2;
    fn rf(raw: &[u8]) -> DecodedPacket {
        let mut packet = decode_tnc2(raw);
        packet.origin = PacketOrigin::Rf;
        // Two addresses with the end-of-address bit set on the second.
        packet.ax25_bytes = Some(vec![0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 3, 0xf0]);
        packet
    }
    #[test]
    fn login_requires_verified_server_response() {
        use std::net::TcpListener;
        for verified in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut line = String::new();
                BufReader::new(stream.try_clone().unwrap())
                    .read_line(&mut line)
                    .unwrap();
                assert!(line.starts_with("user N0ABC pass 12345 "));
                write!(
                    stream,
                    "# logresp N0ABC {}, server test\r\n",
                    if verified { "verified" } else { "unverified" }
                )
                .unwrap();
            });
            assert_eq!(
                authenticate(TcpStream::connect(address).unwrap(), "N0ABC", "12345").is_ok(),
                verified
            );
            server.join().unwrap();
        }
    }
    #[test]
    fn forwards_rf_and_preserves_binary_and_path() {
        let (key, line) = format_packet(&rf(b"K8ABC>APRS,WIDE1-1*:!\xff"), "N0ABC-10").unwrap();
        assert_eq!(line, b"K8ABC>APRS,WIDE1-1*,qAO,N0ABC-10:!\xff\r\n");
        assert_eq!(key, b"K8ABC>APRS:!\xff");
        assert_eq!(
            key,
            format_packet(&rf(b"K8ABC>APRS,WIDE2-2:!\xff"), "N0ABC-10")
                .unwrap()
                .0
        );
    }
    #[test]
    fn rejects_loops_queries_non_ui_and_monitor() {
        for raw in [
            "K8ABC>APRS,TCPIP*:hello",
            "K8ABC>APRS,RFONLY:hello",
            "K8ABC>APRS,NOGATE:hello",
            "K8ABC>APRS,qAR,N0ABC:hello",
            "K8ABC>APRS:?APRS?",
            "K8ABC>APRS:}K9ABC>APRS,TCPXX*:hello",
            "N0ABC-10>APRS:hello",
        ] {
            assert!(
                format_packet(&rf(raw.as_bytes()), "N0ABC-10").is_none(),
                "{raw}"
            );
        }
        let mut packet = rf(b"K8ABC>APRS:hello");
        packet.ax25_bytes.as_mut().unwrap()[14] = 0x13;
        assert!(format_packet(&packet, "N0ABC-10").is_none());
        packet.ax25_bytes = None;
        assert!(format_packet(&packet, "N0ABC-10").is_none());
        packet.origin = PacketOrigin::AprsIs;
        assert!(format_packet(&packet, "N0ABC-10").is_none());
    }
    #[test]
    fn unwraps_third_party_and_checks_length() {
        let (_, line) = format_packet(
            &rf(b"K8ABC>APRS,WIDE1-1:}K9ABC>APRS,WIDE2-1*:hello"),
            "N0ABC",
        )
        .unwrap();
        assert_eq!(line, b"K9ABC>APRS,WIDE2-1*,qAO,N0ABC:hello\r\n");
        assert!(format_packet(
            &rf(format!("K8ABC>APRS:{}", "a".repeat(510)).as_bytes()),
            "N0ABC"
        )
        .is_none());
    }
}
