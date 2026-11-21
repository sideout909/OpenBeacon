//! Opt-in, one-way RF to APRS-IS gateway. Never consumes history or internet packets.
use openbeacon_packet::aprs::{DecodedPacket, PacketOrigin};
use serde::Serialize;
use tauri::{Emitter, Manager};

#[derive(Clone, Serialize)]
struct Status {
    generation: u64,
    state: &'static str,
    message: String,
    forwarded: u64,
    skipped: u64,
}
pub(crate) fn report(
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
pub(crate) fn format_packet(packet: &DecodedPacket, call: &str) -> Option<Vec<u8>> {
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
        let end = raw
            .iter()
            .position(|&b| b == b'\r' || b == b'\n')
            .unwrap_or(raw.len());
        let raw = &raw[..end];
        let colon = raw.iter().position(|&b| b == b':')?;
        let header = &raw[..colon];
        let body = raw.get(colon + 1..)?;
        let gt = header.iter().position(|&b| b == b'>')?;
        if gt == 0
            || gt + 1 == header.len()
            || body.is_empty()
            || !header.iter().all(|b| (33..=126).contains(b))
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
    let mut line = header.to_vec();
    line.extend_from_slice(format!(",qAO,{call}:").as_bytes());
    line.extend_from_slice(body);
    line.extend_from_slice(b"\r\n");
    (line.len() <= 512).then_some(line)
}
pub fn offer(app: &tauri::AppHandle, packets: &[DecodedPacket]) {
    if let (Ok(client), Ok(guard)) = (
        app.state::<crate::aprs_session::AprsSession>().client(app),
        app.state::<crate::tnc::Tnc>().beacon_guard(),
    ) {
        client.offer_with_guard(packets, Some(guard));
    }
}
#[tauri::command]
pub async fn start_igate(app: tauri::AppHandle, callsign: String) -> Result<u64, String> {
    let call = callsign.trim().to_ascii_uppercase();
    if !valid_call(&call) {
        return Err("Enter a valid iGate callsign and optional SSID.".into());
    }
    let pass = Some(crate::beacon::load_passcode(&app, &call)?);
    let client = crate::aprs_session::client(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        client.igate(Some(crate::aprs_session::Credentials { call, pass }))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn stop_igate(app: tauri::AppHandle) -> Result<(), String> {
    let client = crate::aprs_session::client(&app)?;
    tauri::async_runtime::spawn_blocking(move || client.igate(None).map(|_| ()))
        .await
        .map_err(|e| e.to_string())?
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
    fn forwards_rf_and_preserves_binary_and_path() {
        let line = format_packet(&rf(b"K8ABC>APRS,WIDE1-1*:!\xff\x00 x  "), "N0ABC-10").unwrap();
        assert_eq!(line, b"K8ABC>APRS,WIDE1-1*,qAO,N0ABC-10:!\xff\x00 x  \r\n");
        assert_eq!(
            format_packet(&rf(b"K8ABC>APRS:abc\rignored"), "N0ABC-10").unwrap(),
            b"K8ABC>APRS,qAO,N0ABC-10:abc\r\n"
        );
        assert_eq!(
            format_packet(&rf(b"K8ABC>APRS:abc\nignored"), "N0ABC-10").unwrap(),
            b"K8ABC>APRS,qAO,N0ABC-10:abc\r\n"
        );
        assert_eq!(
            format_packet(&rf(b"K8ABC>APRS:repeat"), "N0ABC-10"),
            format_packet(&rf(b"K8ABC>APRS:repeat"), "N0ABC-10")
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
        let line = format_packet(
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
