use openbeacon_packet::aprs::DecodedPacket;
use rusqlite::{params, Connection};
use std::path::Path;
use tauri::Manager;

fn open(path: &Path) -> Result<Connection, String> {
    std::fs::create_dir_all(path).map_err(|e| e.to_string())?;
    let db = Connection::open(path.join("history.sqlite3")).map_err(|e| e.to_string())?;
    db.busy_timeout(std::time::Duration::from_secs(2))
        .map_err(|e| e.to_string())?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS packets (id INTEGER PRIMARY KEY, data TEXT NOT NULL); PRAGMA user_version = 1;").map_err(|e| e.to_string())?;
    Ok(db)
}
pub fn save(app: &tauri::AppHandle, packets: &[DecodedPacket]) -> Result<(), String> {
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut db = open(&path)?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    for packet in packets {
        let data = serde_json::to_string(packet).map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO packets(data) VALUES (?1)", params![data])
            .map_err(|e| e.to_string())?;
    }
    tx.execute("DELETE FROM packets WHERE id < COALESCE((SELECT id FROM packets ORDER BY id DESC LIMIT 1 OFFSET 9999), 0)", []).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}
#[tauri::command]
pub fn load_history(app: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let db = open(&path)?;
    let mut stmt = db
        .prepare("SELECT data FROM packets ORDER BY id DESC LIMIT 10000")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut packets = Vec::new();
    for row in rows {
        packets.push(
            serde_json::from_str(&row.map_err(|e| e.to_string())?)
                .map_err(|e| format!("Invalid stored packet: {e}"))?,
        );
    }
    Ok(packets)
}
