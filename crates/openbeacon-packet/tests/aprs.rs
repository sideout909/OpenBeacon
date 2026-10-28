use openbeacon_packet::{
    aprs::{decode_rf_frame, decode_tnc2},
    ax25::crc16_x25,
};

#[test]
fn uncompressed_position_preserves_header_and_fields() {
    let decoded = decode_tnc2(b"N0ABC-9>APRS,WIDE1-1,qAR,IGATE:!4230.00N/08306.00W>Test");
    let position = decoded
        .position
        .clone()
        .unwrap_or_else(|| panic!("{decoded:?}"));
    assert_eq!(decoded.source, "N0ABC-9");
    assert_eq!(decoded.destination, "APRS");
    assert_eq!(decoded.path, ["WIDE1-1", "qAR", "IGATE"]);
    assert_eq!(position.latitude, 42.5);
    assert!((position.longitude + 83.1).abs() < 0.00001);
    assert_eq!(position.symbol, "/>");
    assert_eq!(position.comment, "Test");
}
#[test]
fn compressed_and_mice_positions_are_plotted_with_symbols() {
    let result = decode_tnc2(b"N0CALL>APRS:!/5L!!<*e7>7P[comment");
    let p = result.position.expect("compressed position");
    assert!((p.latitude - 49.5).abs() < 0.0001);
    assert!((p.longitude + 72.75).abs() < 0.0001);
    assert_eq!(p.symbol, "/>");
    let mic = decode_tnc2(b"N0CALL>ABC123:`a\x1d\x1dDEF>/hello");
    let p = mic.position.expect("Mic-E position");
    assert!((p.latitude + 1.3538333333).abs() < 0.0001);
    assert!((p.longitude - 69.0168333333).abs() < 0.0001);
    assert_eq!(p.symbol, "/>");
    assert_eq!(p.speed_knots, Some(404));
    assert_eq!(mic.raw_bytes, b"N0CALL>ABC123:`a\x1d\x1dDEF>/hello");
}
#[test]
fn ambiguity_is_centered_and_invalid_positions_are_not_plotted() {
    let r = decode_tnc2(b"N0ABC>APRS:!4230.  N/08306.  W>Approximate");
    let p = r.position.expect("ambiguous position");
    assert_eq!(p.ambiguity, 2);
    assert!((p.latitude - 42.508333333).abs() < 0.0001);
    assert!((p.longitude + 83.108333333).abs() < 0.0001);
    assert!(!r.warnings.is_empty());
    for bytes in [
        b"N0ABC>APRS:!4299.00N/08306.00W>bad".as_slice(),
        b"N0ABC>APRS:!9001.00N/08306.00W>bad",
        b"N0ABC>APRS:!423 .  N/08306.  W>bad",
    ] {
        assert!(decode_tnc2(bytes).position.is_none());
    }
}
#[test]
fn messages_weather_and_unsupported_packets_are_not_lost() {
    let m = decode_tnc2(b"N0ABC>APRS::N0XYZ    :Hello{123");
    let m = m.message.expect("message");
    assert_eq!(m.addressee, "N0XYZ");
    assert_eq!(m.text, "Hello");
    assert_eq!(m.id.as_deref(), Some("123"));
    let wx = decode_tnc2(b"N0ABC>APRS:_092345c220s004g010t077r001p002P003h50b10150");
    let w = wx.weather.expect("weather");
    assert_eq!(w.temperature_fahrenheit, Some(77));
    assert_eq!(w.pressure_tenths_hpa, Some(10150));
    let raw = b"N0ABC>APRS:?query";
    let packet = decode_tnc2(raw);
    assert_eq!(packet.raw_bytes, raw);
    assert_eq!(packet.kind, "query");
}
#[test]
fn ax25_ui_frame_feeds_the_same_aprs_decoder() {
    let mut frame = Vec::new();
    for (call, ssid, last) in [("APRS", 0, false), ("N0ABC", 9, true)] {
        for b in format!("{call:<6}").bytes() {
            frame.push(b << 1);
        }
        frame.push(0x60 | (ssid << 1) | u8::from(last));
    }
    frame.extend([0x03, 0xf0]);
    frame.extend(b"!4230.00N/08306.00W>Test");
    let crc = crc16_x25(&frame);
    frame.extend(crc.to_le_bytes());
    let (ax, packet) = decode_rf_frame(&frame, true).unwrap();
    assert_eq!(ax.source, "N0ABC-9");
    assert_eq!(serde_json::to_value(&packet).unwrap()["origin"], "rf");
    assert_eq!(packet.position.unwrap().symbol, "/>");
    frame[18] ^= 1;
    assert!(decode_rf_frame(&frame, true).is_err());
}

#[test]
fn ambiguous_mic_e_is_not_plotted_as_exact_and_bad_bytes_do_not_panic() {
    let packet = decode_tnc2(b"N0CALL>ABCK23:`a\x1d\x1dDEF>/hello");
    assert!(packet.position.is_none());
    assert!(packet.warnings.iter().any(|w| w.contains("Ambiguous")));
    for b in 0u8..=255 {
        let mut bytes = b"N0ABC>APRS:!4230.00N/08306.00W>".to_vec();
        bytes[15] = b;
        let _ = decode_tnc2(&bytes);
    }
}

#[test]
fn serialized_event_preserves_raw_bytes_and_expected_frontend_fields() {
    let raw = b"N0CALL>ABC123:`a\x1d\x1dDEF>/hello";
    let value = serde_json::to_value(decode_tnc2(raw)).unwrap();
    assert_eq!(value["source"], "N0CALL");
    assert_eq!(value["origin"], "unknown");
    assert_eq!(value["kind"], "mic_e");
    assert_eq!(value["position"]["symbol"], "/>");
    assert_eq!(value["position"]["speedKnots"], 404);
    assert_eq!(value["rawBytes"].as_array().unwrap().len(), raw.len());
}

#[test]
fn compressed_positions_without_motion_from_real_capture() {
    let packet = decode_tnc2(b"W8LLC>APGRWO:!/8s<a8sH4-  CGraywolf");
    assert_eq!(packet.kind, "compressed_position");
    let position = packet.position.unwrap();
    assert!(position.latitude > 40.0 && position.latitude < 50.0);
    assert!(position.longitude > -90.0 && position.longitude < -80.0);
    assert_eq!(position.symbol, "/-");
    assert_eq!(position.comment, "Graywolf");
    assert_eq!(position.speed_knots, None);
    let invalid = decode_tnc2(b"N0CALL>APRS:!/ s<a8sH4-  Cexample");
    assert!(invalid.position.is_none());
}
