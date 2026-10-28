// SPDX-License-Identifier: GPL-3.0-or-later
//! Byte-preserving APRS packet interpretation shared by network and RF sources.
use crate::ax25::{Ax25Ui, decode_ax25_ui};
use libaprs_engine::{AprsData, Coordinates, MessageKind, Position, Weather, parse_packet};
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PositionReport {
    pub latitude: f64,
    pub longitude: f64,
    pub symbol: String,
    pub comment: String,
    /// Number of ambiguous coordinate digits; coordinates are the center of the cell.
    pub ambiguity: u8,
    pub timestamp: Option<String>,
    pub speed_knots: Option<u16>,
    pub course_degrees: Option<u16>,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MessageReport {
    pub addressee: String,
    pub kind: String,
    pub text: String,
    pub id: Option<String>,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WeatherReport {
    pub temperature_fahrenheit: Option<i16>,
    pub wind_direction_degrees: Option<u16>,
    pub wind_speed_mph: Option<u16>,
    pub wind_gust_mph: Option<u16>,
    pub rain_last_hour_hundredths_inch: Option<u16>,
    pub rain_last_24_hours_hundredths_inch: Option<u16>,
    pub rain_since_midnight_hundredths_inch: Option<u16>,
    pub humidity_percent: Option<u16>,
    pub pressure_tenths_hpa: Option<u16>,
    pub raw: String,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DecodedPacket {
    /// Interface that delivered this observation, distinct from the station callsign.
    pub origin: PacketOrigin,
    /// Lossy human-readable display; raw_bytes retains the original packet.
    pub raw: String,
    pub raw_bytes: Vec<u8>,
    pub ax25_bytes: Option<Vec<u8>>,
    pub kiss_port: Option<u8>,
    pub source_interface: Option<String>,
    pub source: String,
    pub destination: String,
    pub path: Vec<String>,
    pub kind: String,
    pub received_at: u64,
    pub position: Option<PositionReport>,
    pub message: Option<MessageReport>,
    pub weather: Option<WeatherReport>,
    pub status: Option<String>,
    pub warnings: Vec<String>,
}
/// The transport that delivered a packet. Unknown is used for standalone decoding.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PacketOrigin {
    Unknown,
    AprsIs,
    Rf,
}
fn text(v: &[u8]) -> String {
    String::from_utf8_lossy(v).into_owned()
}
fn printable_symbol(table: u8, code: u8) -> Option<String> {
    if (table == b'/' || table == b'\\' || table.is_ascii_alphanumeric())
        && (33..=126).contains(&code)
    {
        Some(format!("{}{}", table as char, code as char))
    } else {
        None
    }
}
fn valid_coords(p: Coordinates) -> Option<Coordinates> {
    (p.latitude.is_finite()
        && p.longitude.is_finite()
        && (-90.0..=90.0).contains(&p.latitude)
        && (-180.0..=180.0).contains(&p.longitude))
    .then_some(p)
}
fn numeric_minutes(v: &[u8], start: usize) -> bool {
    if v.len() < start + 5 || v[start + 2] != b'.' {
        return false;
    }
    let d = |i: usize| {
        v.get(i)
            .filter(|b| b.is_ascii_digit())
            .map(|b| u16::from(*b - b'0'))
    };
    match (d(start), d(start + 1), d(start + 3), d(start + 4)) {
        (Some(a), Some(b), Some(_), Some(_)) => a * 10 + b < 60,
        _ => false,
    }
}
fn position(
    report: Position<'_>,
    timestamp: Option<String>,
    warnings: &mut Vec<String>,
) -> Option<PositionReport> {
    if !numeric_minutes(report.latitude, 2) || !numeric_minutes(report.longitude, 3) {
        warnings.push("Position contains invalid minute values".into());
        return None;
    }
    let coords = valid_coords(report.coordinates()?)?;
    Some(PositionReport {
        latitude: coords.latitude,
        longitude: coords.longitude,
        symbol: printable_symbol(report.symbol_table, report.symbol_code)?,
        comment: text(report.comment),
        ambiguity: 0,
        timestamp,
        speed_knots: None,
        course_degrees: None,
    })
}
fn weather(report: Weather<'_>) -> WeatherReport {
    let fields = report.fields();
    WeatherReport {
        temperature_fahrenheit: fields.temperature_fahrenheit,
        wind_direction_degrees: fields.wind_direction_degrees,
        wind_speed_mph: fields.wind_speed_mph,
        wind_gust_mph: fields.wind_gust_mph,
        rain_last_hour_hundredths_inch: fields.rain_last_hour_hundredths_inch,
        rain_last_24_hours_hundredths_inch: fields.rain_last_24_hours_hundredths_inch,
        rain_since_midnight_hundredths_inch: fields.rain_since_midnight_hundredths_inch,
        humidity_percent: fields.humidity_percent,
        pressure_tenths_hpa: fields.pressure_tenths_hpa,
        raw: text(report.report),
    }
}
// APRS 1.0.1 permits a space in the compressed course byte to indicate no
// course/speed data. The upstream parser currently requires base91 there.
fn compressed_without_motion(payload: &[u8]) -> Option<PositionReport> {
    let start = match *payload.first()? {
        b'!' | b'=' => 1,
        b'/' | b'@' => 8,
        _ => return None,
    };
    let p = payload.get(start..)?;
    if p.len() < 13 || p[10] != b' ' {
        return None;
    }
    let symbol = printable_symbol(p[0], p[9])?;
    let decode = |bytes: &[u8]| -> Option<f64> {
        bytes
            .iter()
            .try_fold(0u32, |n, &b| {
                if (b'!'..=b'{').contains(&b) {
                    Some(n * 91 + u32::from(b - b'!'))
                } else {
                    None
                }
            })
            .map(f64::from)
    };
    let coords = valid_coords(Coordinates {
        latitude: 90.0 - decode(&p[1..5])? / 380926.0,
        longitude: -180.0 + decode(&p[5..9])? / 190463.0,
    })?;
    Some(PositionReport {
        latitude: coords.latitude,
        longitude: coords.longitude,
        symbol,
        comment: text(&p[13..]),
        ambiguity: 0,
        timestamp: (start == 8).then(|| text(&payload[1..8])),
        speed_knots: None,
        course_degrees: None,
    })
}
/// Parse uncompressed position ambiguity, preserving its precision instead of pretending it is exact.
fn ambiguous_position(payload: &[u8]) -> Option<PositionReport> {
    let start = match *payload.first()? {
        b'!' | b'=' => 1,
        b'/' | b'@' => 8,
        _ => return None,
    };
    let p = payload.get(start..)?;
    if p.len() < 19 {
        return None;
    }
    let mut lat = p.get(..8)?.to_vec();
    let mut lon = p.get(9..18)?.to_vec();
    let lat_idx = [2, 3, 5, 6];
    let lon_idx = [3, 4, 6, 7];
    let lat_count = lat_idx.iter().filter(|&&i| lat[i] == b' ').count();
    let lon_count = lon_idx.iter().filter(|&&i| lon[i] == b' ').count();
    if lat_count == 0 || lat_count != lon_count || lat_count > 4 {
        return None;
    }
    for indices in [(&lat, lat_idx), (&lon, lon_idx)] {
        for (j, &i) in indices.1.iter().enumerate() {
            if j < 4 - lat_count {
                if !indices.0[i].is_ascii_digit() {
                    return None;
                }
            } else if indices.0[i] != b' ' {
                return None;
            }
        }
    }
    for (coord, idx) in [(&mut lat, lat_idx), (&mut lon, lon_idx)] {
        for (j, &i) in idx.iter().enumerate().skip(4 - lat_count) {
            coord[i] = if j == 4 - lat_count {
                if lat_count == 4 { b'3' } else { b'5' }
            } else {
                b'0'
            };
        }
    }
    if !numeric_minutes(&lat, 2) || !numeric_minutes(&lon, 3) {
        return None;
    }
    let lat_deg = std::str::from_utf8(&lat[..2]).ok()?.parse::<f64>().ok()?;
    let lon_deg = std::str::from_utf8(&lon[..3]).ok()?.parse::<f64>().ok()?;
    let lat_min = std::str::from_utf8(&lat[2..7]).ok()?.parse::<f64>().ok()?;
    let lon_min = std::str::from_utf8(&lon[3..8]).ok()?.parse::<f64>().ok()?;
    let latitude = (lat_deg + lat_min / 60.0)
        * match lat[7] {
            b'N' => 1.0,
            b'S' => -1.0,
            _ => return None,
        };
    let longitude = (lon_deg + lon_min / 60.0)
        * match lon[8] {
            b'E' => 1.0,
            b'W' => -1.0,
            _ => return None,
        };
    valid_coords(Coordinates {
        latitude,
        longitude,
    })?;
    let timestamp = (start == 8).then(|| text(&payload[1..8]));
    Some(PositionReport {
        latitude,
        longitude,
        symbol: printable_symbol(p[8], p[18])?,
        comment: text(&p[19..]),
        ambiguity: lat_count as u8,
        timestamp,
        speed_knots: None,
        course_degrees: None,
    })
}
/// Parse any received TNC2 line without losing its bytes, including unsupported data types.
pub fn decode_tnc2(bytes: &[u8]) -> DecodedPacket {
    let mut out = DecodedPacket {
        origin: PacketOrigin::Unknown,
        raw: text(bytes),
        raw_bytes: bytes.to_vec(),
        ax25_bytes: None,
        kiss_port: None,
        source_interface: None,
        source: String::new(),
        destination: String::new(),
        path: vec![],
        kind: "invalid".into(),
        received_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        position: None,
        message: None,
        weather: None,
        status: None,
        warnings: vec![],
    };
    // APRS-IS q constructs and other routing identifiers are not AX.25 addresses.
    // Preserve the original header, and feed the payload plus destination to the
    // APRS semantic parser without asking it to validate Internet-only path parts.
    let Some(sep) = bytes.iter().position(|&b| b == b':') else {
        out.warnings.push("Missing packet payload separator".into());
        return out;
    };
    let Some(gt) = bytes[..sep].iter().position(|&b| b == b'>') else {
        out.warnings
            .push("Missing source/destination separator".into());
        return out;
    };
    let header = &bytes[gt + 1..sep];
    let mut components = header.split(|b| *b == b',');
    let dest = components.next().unwrap_or_default();
    let source = &bytes[..gt];
    if source.is_empty()
        || dest.is_empty()
        || sep + 1 >= bytes.len()
        || bytes.len() > 2048
        || !source.iter().all(u8::is_ascii)
        || !header.iter().all(u8::is_ascii)
    {
        out.warnings
            .push("Invalid packet header or empty payload".into());
        return out;
    }
    out.source = text(source);
    out.destination = text(dest);
    out.path = components.map(text).collect();
    let mut normalized = b"N0CALL>".to_vec();
    normalized.extend(dest.iter().map(u8::to_ascii_uppercase));
    normalized.push(b':');
    normalized.extend_from_slice(&bytes[sep + 1..]);
    let packet = match parse_packet(&normalized) {
        Ok(p) => p,
        Err(e) => {
            out.warnings
                .push(format!("Unable to parse APRS payload: {e:?}"));
            return out;
        }
    };
    let data = packet.aprs_data();
    out.kind = data.kind_name().into();
    match data {
        AprsData::Position(p) => {
            out.position = position(p, None, &mut out.warnings);
            out.weather = p.weather().map(weather);
        }
        AprsData::TimestampedPosition(p) => {
            out.position = position(p.position, Some(text(p.timestamp)), &mut out.warnings);
            out.weather = p.weather().map(weather);
        }
        AprsData::CompressedPosition(p) => {
            if let (Some(c), Some(symbol)) = (
                p.coordinates().and_then(valid_coords),
                printable_symbol(p.symbol_table, p.symbol_code),
            ) {
                out.position = Some(PositionReport {
                    latitude: c.latitude,
                    longitude: c.longitude,
                    symbol,
                    comment: text(p.comment),
                    ambiguity: 0,
                    timestamp: matches!(packet.payload().first(), Some(b'/' | b'@'))
                        .then(|| text(&packet.payload()[1..8])),
                    speed_knots: None,
                    course_degrees: None,
                });
            } else {
                out.warnings
                    .push("Compressed position could not be decoded".into());
            }
            out.weather = p.weather().map(weather);
        }
        AprsData::MicE(p) => {
            // K/L/Z in the Mic-E destination encode position ambiguity. The upstream
            // parser currently replaces them with zero; never claim that point is exact.
            let ambiguous = p
                .destination
                .iter()
                .any(|b| matches!(b, b'K' | b'L' | b'Z'));
            let c = if ambiguous {
                out.warnings
                    .push("Ambiguous Mic-E position is not plotted yet".into());
                None
            } else {
                p.coordinates().and_then(valid_coords)
            };
            let symbol = p.body.get(6..8).and_then(|v| printable_symbol(v[1], v[0]));
            if let (Some(c), Some(symbol)) = (c, symbol) {
                let speed = p.speed_course();
                out.position = Some(PositionReport {
                    latitude: c.latitude,
                    longitude: c.longitude,
                    symbol,
                    comment: text(p.body.get(8..).unwrap_or_default()),
                    ambiguity: 0,
                    timestamp: None,
                    speed_knots: speed.map(|v| v.speed_knots),
                    course_degrees: speed.map(|v| v.course_degrees).filter(|v| *v <= 360),
                });
            } else {
                out.warnings
                    .push("Mic-E position or symbol could not be decoded".into());
            }
        }
        AprsData::Status { text: body } => out.status = Some(text(body)),
        AprsData::Message(m) => {
            out.message = Some(MessageReport {
                addressee: text(m.addressee).trim().into(),
                kind: match m.kind {
                    MessageKind::Message => "message",
                    MessageKind::Ack => "ack",
                    MessageKind::Reject => "reject",
                    MessageKind::Bulletin => "bulletin",
                    MessageKind::Announcement => "announcement",
                }
                .into(),
                text: text(m.text),
                id: m.id.map(text),
            })
        }
        AprsData::Weather(w) => out.weather = Some(weather(w)),
        AprsData::Object(o) => {
            out.weather = o.weather().map(weather);
            out.warnings
                .push("Object display is not implemented".into());
        }
        AprsData::Item(i) => {
            out.weather = i.weather().map(weather);
            out.warnings.push("Item display is not implemented".into());
        }
        AprsData::Malformed { .. } => {
            if let Some(p) = compressed_without_motion(packet.payload()) {
                out.position = Some(p);
                out.kind = "compressed_position".into();
            } else if let Some(p) = ambiguous_position(packet.payload()) {
                out.position = Some(p);
                out.kind = "ambiguous_position".into();
                out.warnings
                    .push("Position is approximate due to APRS ambiguity".into());
            } else {
                out.warnings
                    .push("Malformed or unsupported variant of APRS data".into());
            }
        }
        AprsData::Unsupported { .. } => out.warnings.push("Unsupported APRS data type".into()),
        _ => {}
    }
    out
}
/// Decode an AX.25 UI frame into the same APRS result used for APRS-IS.
pub fn decode_rf_frame(
    frame: &[u8],
    includes_fcs: bool,
) -> Result<(Ax25Ui, DecodedPacket), String> {
    let ax = decode_ax25_ui(frame, includes_fcs)?;
    if ax.pid != 0xf0 {
        return Err(format!("AX.25 PID {:02X} is not APRS UI data", ax.pid));
    }
    let mut line = format!("{}>{}", ax.source, ax.destination).into_bytes();
    for path in &ax.via {
        line.push(b',');
        line.extend_from_slice(path.as_bytes());
    }
    line.push(b':');
    line.extend_from_slice(&ax.payload);
    let mut result = decode_tnc2(&line);
    result.origin = PacketOrigin::Rf;
    result.ax25_bytes = Some(frame.to_vec());
    Ok((ax, result))
}
