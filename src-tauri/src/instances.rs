use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// One installed instance. Stored in launcher/config/instances.json
#[derive(Serialize, Deserialize, Clone)]
pub struct Instance {
    pub id: String,         // folder name in game/instances/
    pub name: String,       // what you typed
    pub loader: String,     // vanilla | fabric | quilt | forge | neoforge
    pub mc: String,         // Minecraft version
    pub version_id: String, // profile in game/versions/ (e.g. fabric-loader-0.16.x-1.20.1)
    #[serde(default)]
    pub icon: String, // custom logo as a data URL, empty = default for the loader
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub background: String, // background filename in the instance folder, empty = none
}

pub fn load(dir: &Path) -> Vec<Instance> {
    std::fs::read_to_string(dir.join("instances.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(dir: &Path, list: &[Instance]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(list)
        .map_err(|e| format!("Failed to serialize instance list: {e}"))?;
    std::fs::write(dir.join("instances.json"), json)
        .map_err(|e| format!("Failed to save instance list: {e}"))
}

const BACKGROUND_FILES: [&str; 4] = [
    "background.gif",
    "background.png",
    "background.jpg",
    "background.jpeg",
];

pub fn save_background(instance_dir: &Path, data_url: &str) -> Result<String, String> {
    if data_url.is_empty() {
        remove_background_files(instance_dir)?;
        return Ok(String::new());
    }

    let (_, extension) = [
        ("image/gif", "gif"),
        ("image/png", "png"),
        ("image/jpeg", "jpg"),
    ]
    .into_iter()
    .find(|(mime, _)| data_url.starts_with(&format!("data:{mime};base64,")))
    .ok_or_else(|| "Background must be a GIF, PNG, or JPEG image".to_string())?;
    let encoded = data_url
        .split_once(',')
        .map(|(_, data)| data)
        .ok_or_else(|| "Background image data is invalid".to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("Background image data is invalid: {e}"))?;
    if bytes.is_empty() {
        return Err("Background image is empty".into());
    }

    std::fs::create_dir_all(instance_dir)
        .map_err(|e| format!("Failed to create instance folder: {e}"))?;
    let filename = format!("background.{extension}");
    std::fs::write(instance_dir.join(&filename), bytes)
        .map_err(|e| format!("Failed to save background image: {e}"))?;
    remove_background_files_except(instance_dir, &filename)?;
    Ok(filename)
}

pub fn read_background(instance_dir: &Path, filename: &str) -> Result<Option<String>, String> {
    if filename.is_empty() {
        return Ok(None);
    }
    // Older launcher versions stored backgrounds directly in instances.json.
    if filename.starts_with("data:image/") {
        return Ok(Some(filename.to_string()));
    }
    if !BACKGROUND_FILES.contains(&filename) {
        return Err("Invalid background image path".into());
    }
    let path = instance_dir.join(filename);
    if !path.exists() {
        return Ok(None);
    }
    let mime = match PathBuf::from(filename)
        .extension()
        .and_then(|ext| ext.to_str())
    {
        Some("gif") => "image/gif",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        _ => return Err("Unsupported background image format".into()),
    };
    let bytes =
        std::fs::read(&path).map_err(|e| format!("Failed to read background image: {e}"))?;
    Ok(Some(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )))
}

fn remove_background_files(instance_dir: &Path) -> Result<(), String> {
    remove_background_files_except(instance_dir, "")
}

fn remove_background_files_except(instance_dir: &Path, keep: &str) -> Result<(), String> {
    for filename in BACKGROUND_FILES {
        if filename == keep {
            continue;
        }
        match std::fs::remove_file(instance_dir.join(filename)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Failed to remove old background image: {error}")),
        }
    }
    Ok(())
}
