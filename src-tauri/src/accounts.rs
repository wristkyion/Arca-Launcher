use serde::{Deserialize, Serialize};
use std::path::Path;

/// One saved account. Stored in launcher/config/accounts.json
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Stored {
    pub id: String,
    pub kind: String, // "offline" | "elyby" | "microsoft"
    pub username: String,
    pub uuid: String,
    #[serde(default)]
    pub access_token: String, // Ely.by
    #[serde(default)]
    pub client_token: String, // Ely.by
    #[serde(default)]
    pub refresh_token: String, // Microsoft
}

#[derive(Serialize, Deserialize, Default)]
pub struct Store {
    #[serde(default)]
    pub selected: Option<String>,
    #[serde(default)]
    pub accounts: Vec<Stored>,
}

pub fn load(dir: &Path) -> Store {
    std::fs::read_to_string(dir.join("accounts.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(dir: &Path, s: &Store) {
    let _ = std::fs::write(
        dir.join("accounts.json"),
        serde_json::to_string_pretty(s).unwrap(),
    );
}
