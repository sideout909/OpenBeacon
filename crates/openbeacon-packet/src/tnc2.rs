// SPDX-License-Identifier: GPL-3.0-or-later
//! Bounded, byte-preserving APRS-IS line framing.
#[derive(Debug, PartialEq, Eq)]
pub enum Line {
    Data(Vec<u8>),
    Oversized,
}
#[derive(Default)]
pub struct LineDecoder {
    pending: Vec<u8>,
    oversized: bool,
}
impl LineDecoder {
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<Line> {
        let mut lines = Vec::new();
        for &byte in bytes {
            if byte == b'\n' {
                if self.oversized {
                    lines.push(Line::Oversized);
                } else {
                    if self.pending.last() == Some(&b'\r') {
                        self.pending.pop();
                    }
                    if !self.pending.is_empty() {
                        lines.push(Line::Data(std::mem::take(&mut self.pending)));
                    }
                }
                self.pending.clear();
                self.oversized = false;
            } else if !self.oversized && self.pending.len() < 2048 {
                self.pending.push(byte);
            } else {
                self.oversized = true;
            }
        }
        lines
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chunks_preserve_non_utf8_bytes_and_trailing_payload_spaces() {
        let mut d = LineDecoder::default();
        assert!(d.feed(b"N0ABC>APRS:`x\xff").is_empty());
        assert_eq!(
            d.feed(b"  \r\n# login\n"),
            vec![
                Line::Data(b"N0ABC>APRS:`x\xff  ".to_vec()),
                Line::Data(b"# login".to_vec())
            ]
        );
    }
    #[test]
    fn oversize_line_is_discarded_and_next_packet_survives() {
        let mut d = LineDecoder::default();
        let mut bytes = vec![b'x'; 3000];
        bytes.extend_from_slice(b"\nN0ABC>APRS:>ok\n");
        assert_eq!(
            d.feed(&bytes),
            vec![Line::Oversized, Line::Data(b"N0ABC>APRS:>ok".to_vec())]
        );
    }
}
