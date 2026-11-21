//! Liveness for external TNCs. Silence is a suspicion, not proof of hardware failure.
use std::time::{Duration, Instant};

pub(crate) const STALE_AFTER: Duration = Duration::from_secs(5 * 60);
pub(crate) const RETRY_EVERY: Duration = Duration::from_secs(60);
pub(crate) fn retry_delay(attempt_elapsed: Duration) -> Duration {
    RETRY_EVERY.saturating_sub(attempt_elapsed)
}

pub(crate) struct Watchdog {
    since: Instant,
    recovering: bool,
}
impl Watchdog {
    pub(crate) fn new(now: Instant, recovering: bool) -> Self {
        Self {
            since: now,
            recovering,
        }
    }
    pub(crate) fn packet(&mut self, now: Instant) -> bool {
        self.since = now;
        let confirmed = self.recovering;
        self.recovering = false;
        confirmed
    }
    pub(crate) fn expired(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.since)
            >= if self.recovering {
                RETRY_EVERY
            } else {
                STALE_AFTER
            }
    }
    pub(crate) fn recovering(&self) -> bool {
        self.recovering
    }
}

/// Recognize raw, checksum-valid NMEA sentences at the start of a KISS segment.
/// A GPS-looking string inside an AX.25 frame must never trigger a reconnect.
#[derive(Default)]
pub(crate) struct NmeaDetector {
    at_boundary: bool,
    initialized: bool,
    collecting: bool,
    after_fend: bool,
    framed: bool,
    line: Vec<u8>,
}
impl NmeaDetector {
    pub(crate) fn feed(&mut self, input: &[u8]) -> bool {
        self.feed_inner(input, false)
    }
    pub(crate) fn feed_text(&mut self, input: &[u8]) -> bool {
        self.feed_inner(input, true)
    }
    fn feed_inner(&mut self, input: &[u8], text_mode: bool) -> bool {
        if !self.initialized {
            self.at_boundary = true;
            self.initialized = true;
        }
        let mut found = false;
        for &b in input {
            if b == 0xc0 {
                self.line.clear();
                self.collecting = false;
                self.at_boundary = true;
                self.after_fend = !text_mode;
                self.framed = false;
                continue;
            }
            if self.at_boundary && b == b'$' {
                self.line.clear();
                self.line.push(b);
                self.collecting = true;
                self.at_boundary = false;
                self.after_fend = false;
                continue;
            }
            if self.after_fend && b != b'\r' && b != b'\n' {
                self.after_fend = false;
                self.framed = true;
                self.at_boundary = false;
                continue;
            }
            if self.collecting {
                if b == b'\r' || b == b'\n' {
                    found |= is_gps(&self.line);
                    self.line.clear();
                    self.collecting = false;
                    self.at_boundary = true;
                } else if (32..=126).contains(&b) && self.line.len() < 120 {
                    self.line.push(b);
                } else {
                    self.line.clear();
                    self.collecting = false;
                    self.at_boundary = false;
                }
            } else if (text_mode || !self.framed) && (b == b'\r' || b == b'\n') {
                self.at_boundary = true;
            } else if self.at_boundary && b != b'\r' && b != b'\n' {
                self.at_boundary = false;
            }
        }
        found
    }
}
fn is_gps(line: &[u8]) -> bool {
    if line.len() < 10
        || line[0] != b'$'
        || line[1] != b'G'
        || !matches!(line[2], b'P' | b'N' | b'L' | b'A' | b'B')
    {
        return false;
    }
    let star = line.len() - 3;
    if line[star] != b'*' {
        return false;
    }
    let Ok(hex) = std::str::from_utf8(&line[star + 1..]) else {
        return false;
    };
    let Ok(checksum) = u8::from_str_radix(hex, 16) else {
        return false;
    };
    line[1..star].iter().fold(0, |sum, b| sum ^ b) == checksum
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn silence_and_confirmation_have_distinct_deadlines() {
        let now = Instant::now();
        let mut w = Watchdog::new(now, false);
        assert!(!w.expired(now + STALE_AFTER - Duration::from_millis(1)));
        assert!(w.expired(now + STALE_AFTER));
        w = Watchdog::new(now, true);
        assert!(!w.expired(now + RETRY_EVERY - Duration::from_millis(1)));
        assert!(w.expired(now + RETRY_EVERY));
        assert!(w.packet(now + RETRY_EVERY));
        assert!(!w.recovering());
        assert!(!w.expired(now + RETRY_EVERY + Duration::from_secs(61)));
        assert_eq!(retry_delay(Duration::from_secs(2)), Duration::from_secs(58));
        assert_eq!(retry_delay(Duration::from_secs(60)), Duration::ZERO);
        assert_eq!(retry_delay(Duration::from_secs(300)), Duration::ZERO);
    }
    #[test]
    fn detects_fragmented_gps_and_ignores_nmea_inside_kiss() {
        let gps = b"$GPGLL,4916.45,N,12311.12,W,225444,A,*1D\r\n";
        let mut d = NmeaDetector::default();
        assert!(!d.feed(&gps[..10]));
        assert!(d.feed(&gps[10..]));
        let mut kiss = vec![0xc0, 0];
        kiss.extend_from_slice(gps);
        kiss.push(0xc0);
        assert!(!NmeaDetector::default().feed(&kiss));
        let mut text = b"K1ABC>APRS:hello\r\n".to_vec();
        text.extend_from_slice(gps);
        assert!(NmeaDetector::default().feed_text(&text));
        assert!(NmeaDetector::default().feed(&text));
        assert!(!NmeaDetector::default().feed(b"$GPGLL,4916.45,N,12311.12,W,225444,A,*1E\r\n"));
    }
}
