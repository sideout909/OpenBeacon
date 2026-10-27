// SPDX-License-Identifier: GPL-3.0-or-later
//! Bounded KISS stream framing and AX.25 UI interpretation. No RF modem here.
const FEND: u8 = 0xC0;
const FESC: u8 = 0xDB;
const TFEND: u8 = 0xDC;
const TFESC: u8 = 0xDD;
const MAX_FRAME: usize = 4096;
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KissFrame {
    pub port: u8,
    pub bytes: Vec<u8>,
}
#[derive(Default)]
pub struct KissDecoder {
    buffer: Vec<u8>,
    started: bool,
    escaped: bool,
    discard: bool,
}
impl KissDecoder {
    pub fn feed(&mut self, input: &[u8]) -> Vec<Result<KissFrame, String>> {
        let mut output = Vec::new();
        for &byte in input {
            if byte == FEND {
                if self.started && !self.discard && !self.buffer.is_empty() {
                    if self.escaped {
                        output.push(Err("Incomplete KISS escape".into()));
                    } else if self.buffer[0] & 0x0F == 0 {
                        output.push(Ok(KissFrame {
                            port: self.buffer[0] >> 4,
                            bytes: self.buffer[1..].to_vec(),
                        }));
                    }
                }
                self.buffer.clear();
                self.started = true;
                self.escaped = false;
                self.discard = false;
                continue;
            }
            if !self.started || self.discard {
                continue;
            }
            let decoded = if self.escaped {
                self.escaped = false;
                match byte {
                    TFEND => FEND,
                    TFESC => FESC,
                    _ => {
                        self.discard = true;
                        output.push(Err("Invalid KISS escape; frame discarded".into()));
                        continue;
                    }
                }
            } else if byte == FESC {
                self.escaped = true;
                continue;
            } else {
                byte
            };
            if self.buffer.len() >= MAX_FRAME {
                self.discard = true;
                output.push(Err("KISS frame exceeds 4096 bytes".into()));
            } else {
                self.buffer.push(decoded);
            }
        }
        output
    }
}
pub fn encode_kiss(port: u8, frame: &[u8]) -> Result<Vec<u8>, String> {
    if port > 15 || frame.len() + 1 > MAX_FRAME {
        return Err("Invalid KISS port or frame length".into());
    }
    let mut out = vec![FEND];
    for byte in std::iter::once(port << 4).chain(frame.iter().copied()) {
        match byte {
            FEND => out.extend([FESC, TFEND]),
            FESC => out.extend([FESC, TFESC]),
            _ => out.push(byte),
        }
    }
    out.push(FEND);
    Ok(out)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ax25Ui {
    pub source: String,
    pub destination: String,
    pub via: Vec<String>,
    pub pid: u8,
    pub payload: Vec<u8>,
}
impl Ax25Ui {
    pub fn payload_text(&self) -> String {
        String::from_utf8_lossy(&self.payload).into_owned()
    }
}
pub fn decode_ax25_ui(frame: &[u8], includes_fcs: bool) -> Result<Ax25Ui, String> {
    if frame.len() < 16 || frame.len() > MAX_FRAME {
        return Err("AX.25 frame length is invalid".into());
    }
    let frame = if includes_fcs {
        let end = frame.len() - 2;
        let expected = u16::from_le_bytes([frame[end], frame[end + 1]]);
        if crc16_x25(&frame[..end]) != expected {
            return Err("AX.25 FCS mismatch".into());
        }
        &frame[..end]
    } else {
        frame
    };
    let mut addresses = Vec::new();
    let mut offset = 0;
    loop {
        if offset + 7 > frame.len() || addresses.len() >= 10 {
            return Err("Invalid AX.25 address chain".into());
        }
        let a = &frame[offset..offset + 7];
        let mut call = String::new();
        for &byte in &a[..6] {
            let c = byte >> 1;
            if byte & 1 != 0 || !(c.is_ascii_uppercase() || c.is_ascii_digit() || c == b' ') {
                return Err("Invalid AX.25 callsign encoding".into());
            }
            call.push(c as char);
        }
        let mut call = call.trim_end().to_owned();
        if call.is_empty() || call.contains(' ') {
            return Err("Invalid AX.25 callsign padding".into());
        }
        let ssid = (a[6] >> 1) & 15;
        if ssid > 0 {
            call.push_str(&format!("-{ssid}"));
        }
        if addresses.len() >= 2 && a[6] & 0x80 != 0 {
            call.push('*');
        }
        addresses.push(call);
        offset += 7;
        if a[6] & 1 != 0 {
            break;
        }
    }
    if addresses.len() < 2 || offset + 2 > frame.len() {
        return Err("AX.25 source/control fields are missing".into());
    }
    if frame[offset] & 0xEF != 0x03 {
        return Err(format!(
            "AX.25 control {:02X} is not a UI frame",
            frame[offset]
        ));
    }
    Ok(Ax25Ui {
        destination: addresses[0].clone(),
        source: addresses[1].clone(),
        via: addresses[2..].to_vec(),
        pid: frame[offset + 1],
        payload: frame[offset + 2..].to_vec(),
    })
}
pub fn crc16_x25(bytes: &[u8]) -> u16 {
    let mut crc = 0xFFFFu16;
    for &byte in bytes {
        crc ^= byte as u16;
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0x8408
            } else {
                crc >> 1
            };
        }
    }
    crc ^ 0xFFFF
}

/// Parse an operator's future transmit path. Does not encode or send a frame.
/// Empty means direct; RX frames retain their own path unchanged.
pub fn parse_path(value: &str) -> Result<Vec<String>, String> {
    if value.len() > 96 {
        return Err("Packet path is too long".into());
    }
    if value.trim().is_empty() {
        return Ok(Vec::new());
    }
    let parts: Vec<_> = value
        .split(',')
        .map(|s| s.trim().to_ascii_uppercase())
        .collect();
    if parts.len() > 8 {
        return Err("AX.25 supports at most eight path addresses".into());
    }
    for part in &parts {
        let (call, ssid) = part
            .split_once('-')
            .map_or((part.as_str(), None), |(call, ssid)| (call, Some(ssid)));
        if call.is_empty()
            || call.len() > 6
            || !call
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
        {
            return Err(
                "Use comma-separated AX.25 callsigns, optionally with an SSID from 0 to 15".into(),
            );
        }
        if let Some(ssid) = ssid
            && (ssid.is_empty()
                || ssid.len() > 2
                || !ssid.bytes().all(|b| b.is_ascii_digit())
                || !ssid.parse::<u8>().is_ok_and(|n| n <= 15))
        {
            return Err("Packet path SSID must be 0–15".into());
        }
    }
    Ok(parts)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn frame() -> Vec<u8> {
        let mut out = Vec::new();
        for (call, ssid, last) in [("APRS", 0, false), ("N8XYZ", 12, true)] {
            for b in format!("{call:<6}").bytes() {
                out.push(b << 1);
            }
            out.push(0x60 | (ssid << 1) | u8::from(last));
        }
        out.extend([0x03, 0xF0]);
        out.extend(b"T#001,123,045,067,089,010,10101010");
        out
    }
    #[test]
    fn satellite_path_accepts_ariss_or_an_explicit_override_without_changing_rx() {
        assert_eq!(parse_path(" ariss ").unwrap(), ["ARISS"]);
        assert_eq!(
            parse_path("wide1-1, wide2-2").unwrap(),
            ["WIDE1-1", "WIDE2-2"]
        );
        assert!(parse_path("").unwrap().is_empty());
        for invalid in [
            "ARISS,,WIDE1-1",
            "TOOLONG",
            "WIDE1-16",
            "ARISS*",
            "ARISS;TX;",
            "WIDE1-",
        ] {
            assert!(parse_path(invalid).is_err(), "{invalid}");
        }
    }
    #[test]
    fn fragmented_escaped_frames_preserve_port_and_binary_payload() {
        let payload = [1, FEND, 2, FESC, 3];
        let wire = encode_kiss(12, &payload).unwrap();
        let mut decoder = KissDecoder::default();
        let mut frames = Vec::new();
        for byte in wire {
            frames.extend(decoder.feed(&[byte]));
        }
        assert_eq!(
            frames,
            vec![Ok(KissFrame {
                port: 12,
                bytes: payload.to_vec()
            })]
        );
    }
    #[test]
    fn ui_callsigns_ssids_and_payload_are_decoded() {
        let packet = decode_ax25_ui(&frame(), false).unwrap();
        assert_eq!(packet.destination, "APRS");
        assert_eq!(packet.source, "N8XYZ-12");
        assert_eq!(packet.pid, 0xF0);
        assert!(packet.payload_text().starts_with("T#001"));
    }
    #[test]
    fn crc_known_check_and_corruption_detection() {
        assert_eq!(crc16_x25(b"123456789"), 0x906E);
        let mut bytes = frame();
        bytes.extend(crc16_x25(&bytes).to_le_bytes());
        assert!(decode_ax25_ui(&bytes, true).is_ok());
        bytes[16] ^= 1;
        assert!(decode_ax25_ui(&bytes, true).is_err());
    }
    #[test]
    fn malformed_frame_resynchronizes_and_nondata_commands_are_ignored() {
        let valid = encode_kiss(0, &frame()).unwrap();
        let mut input = vec![FEND, 0, FESC, 0x01, FEND, 0x01, 50, FEND];
        input.extend(valid);
        let output = KissDecoder::default().feed(&input);
        assert!(output[0].is_err());
        assert_eq!(output.iter().filter(|f| f.is_ok()).count(), 1);
    }
    #[test]
    fn oversized_frame_is_bounded_and_next_frame_survives() {
        let mut decoder = KissDecoder::default();
        let mut bytes = vec![FEND, 0];
        bytes.extend(vec![0x42; 6000]);
        bytes.extend(encode_kiss(0, &frame()).unwrap());
        let output = decoder.feed(&bytes);
        assert!(output.iter().any(Result::is_err));
        assert_eq!(output.iter().filter(|f| f.is_ok()).count(), 1);
        assert!(decoder.buffer.capacity() < 8192);
    }
}
