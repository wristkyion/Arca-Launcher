use serde::{Deserialize, Serialize};
use std::path::Path;

/// One installed instance. Stored in launcher/config/instances.json
#[derive(Serialize, Deserialize, Clone)]
pub struct Instance {
    pub id: String,         // folder name in game/instances/
    pub name: String,       // what you typed
    pub loader: String,     // vanilla | fabric | quilt | forge | neoforge
    pub mc: String,         // Minecraft version
    pub version_id: String, // profile in game/versions/ (e.g. fabric-loader-0.16.x-1.20.1)
    #[serde(default)]
    pub icon: String,       // custom logo as a data URL, empty = default for the loader
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub background: String, // custom background as a data URL, empty = none
}

pub fn load(dir: &Path) -> Vec<Instance> {
    std::fs::read_to_string(dir.join("instances.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(dir: &Path, list: &[Instance]) {
    let _ = std::fs::write(dir.join("instances.json"), serde_json::to_string_pretty(list).unwrap());
}