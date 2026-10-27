use crate::{
    beacon,
    tnc::{self, Tnc},
};
use tauri::State;

fn payload(to: &str, text: &str, id: &str, ack: bool) -> Result<String, String> {
    let mut parts = to.split('-');
    let base = parts.next().unwrap_or("");
    let ssid = parts.next();
    if !(3..=6).contains(&base.len())
        || !base
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
        || parts.next().is_some()
        || ssid.is_some_and(|s| {
            s.is_empty()
                || s.len() > 2
                || !s.bytes().all(|b| b.is_ascii_digit())
                || !s.parse::<u8>().is_ok_and(|n| n <= 15)
        })
    {
        return Err("Enter a valid destination callsign and SSID.".into());
    }
    if id.is_empty() || id.len() > 5 || !id.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err("Invalid message ID.".into());
    }
    if ack {
        return Ok(format!(":{to:<9}:ack{id}"));
    }
    if text.is_empty()
        || text.len() > 67
        || !text.bytes().all(|b| (32..=126).contains(&b) && b != b'{')
    {
        return Err("Use 1–67 printable ASCII characters; { is reserved for message IDs.".into());
    }
    Ok(format!(":{to:<9}:{text}{{{id}"))
}

#[derive(serde::Deserialize)]
pub struct MessageRequest {
    callsign: String,
    to: String,
    text: String,
    id: String,
    ack: bool,
    route: String,
    path: String,
}
#[tauri::command]
pub async fn send_aprs_message(
    app: tauri::AppHandle,
    state: State<'_, Tnc>,
    request: MessageRequest,
) -> Result<String, String> {
    let MessageRequest {
        callsign,
        to,
        text,
        id,
        ack,
        route,
        path,
    } = request;
    let call = callsign.trim().to_ascii_uppercase();
    let to = to.trim().to_ascii_uppercase();
    // Reuse the same address validation for the sender.
    payload(&call, "x", "1", false)?;
    let body = payload(&to, &text, &id, ack)?;
    match route.as_str() {
        "rf" => tnc::send_rf_payload(state, call, path, body).await,
        "ip" => {
            let passcode = beacon::load_passcode(&app, &call)?;
            if passcode.is_empty()
                || passcode.len() > 5
                || !passcode.bytes().all(|b| b.is_ascii_digit())
            {
                return Err("Save a valid APRS-IS passcode in My Station.".into());
            }
            tauri::async_runtime::spawn_blocking(move || beacon::transmit(&call, &passcode, &body))
                .await
                .map_err(|e| e.to_string())?
        }
        _ => Err("Choose APRS-IS or RF.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn message_and_ack_format_and_validation() {
        assert_eq!(
            payload("K8OTY-1", "Hello", "A1", false).unwrap(),
            ":K8OTY-1  :Hello{A1"
        );
        assert_eq!(
            payload("K8OTY", "", "A1", true).unwrap(),
            ":K8OTY    :ackA1"
        );
        assert!(payload("BAD-16", "hello", "1", false).is_err());
        assert!(payload("K8OTY", "bad{data", "1", false).is_err());
    }
}
