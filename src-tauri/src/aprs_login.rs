//! Parsing shared APRS-IS login responses for receive and transmit sessions.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum LoginStatus {
    Verified,
    Unverified,
}

pub(crate) fn parse_login_response(line: &[u8], call: &str) -> Option<LoginStatus> {
    let line = std::str::from_utf8(line).ok()?;
    let fields: Vec<_> = line.split_whitespace().collect();
    if fields.first() != Some(&"#") || fields.get(1) != Some(&"logresp") {
        return None;
    }
    if !fields
        .get(2)?
        .trim_end_matches(',')
        .eq_ignore_ascii_case(call)
    {
        return None;
    }
    let status = fields.get(3)?.trim_end_matches(',');
    if status.eq_ignore_ascii_case("verified") {
        Some(LoginStatus::Verified)
    } else if status.eq_ignore_ascii_case("unverified") {
        Some(LoginStatus::Unverified)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_matching_identity_and_exact_verification() {
        assert_eq!(
            parse_login_response(b"# logresp K8OTY-15 verified, server x", "k8oty-15"),
            Some(LoginStatus::Verified)
        );
        assert_eq!(
            parse_login_response(b"# logresp K8OTY-15 unverified, server x", "K8OTY-15"),
            Some(LoginStatus::Unverified)
        );
        assert_eq!(
            parse_login_response(b"# logresp K8OTY verified, server x", "K8OTY-15"),
            None
        );
        assert_eq!(
            parse_login_response(b"# logresp K8OTY-15 notverified, server x", "K8OTY-15"),
            None
        );
        assert_eq!(parse_login_response(b"# server greeting", "K8OTY-15"), None);
    }
}
