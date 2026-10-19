use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const META_FILE: &str = "instances.json";

/// One Minecraft instance, as the rest of the app and the frontend see it. The folder's own
/// name under the instances directory is this instance's identity (`id`) - it's filled in when
/// the folder is read, and is never itself stored inside that folder's instances.json.
#[derive(Serialize, Clone)]
pub struct Instance {
    pub id: String,
    pub name: String,
    pub loader: String,
    pub mc: String,
    pub version_id: String,
    pub icon: String,
    pub description: String,
    pub background: String,
}

/// The on-disk shape of <instance folder>/instances.json - everything about an instance except
/// its id, since the folder itself is the id.
#[derive(Serialize, Deserialize, Clone, Default)]
struct OnDisk {
    name: String,
    loader: String,
    mc: String,
    version_id: String,
    #[serde(default)]
    icon: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    background: String,
}

impl Instance {
    fn from_disk(id: String, d: OnDisk) -> Self {
        Instance {
            id,
            name: d.name,
            loader: d.loader,
            mc: d.mc,
            version_id: d.version_id,
            icon: d.icon,
            description: d.description,
            background: d.background,
        }
    }

    fn to_disk(&self) -> OnDisk {
        OnDisk {
            name: self.name.clone(),
            loader: self.loader.clone(),
            mc: self.mc.clone(),
            version_id: self.version_id.clone(),
            icon: self.icon.clone(),
            description: self.description.clone(),
            background: self.background.clone(),
        }
    }
}

/// Reads one instance folder's instances.json, if present. `Ok(None)` means the folder has no
/// instances.json and isn't an instance (e.g. a stray folder a user dropped in there) - that is
/// not an error.
pub fn read_one(instance_dir: &Path) -> Result<Option<Instance>, String> {
    let path = instance_dir.join(META_FILE);
    let contents = match std::fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not read {}: {error}", path.display())),
    };
    let disk: OnDisk = serde_json::from_str(&contents)
        .map_err(|e| format!("Could not parse {}: {e}", path.display()))?;
    let id = instance_dir
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("Invalid instance folder name: {}", instance_dir.display()))?
        .to_string();
    Ok(Some(Instance::from_disk(id, disk)))
}

/// Writes (or overwrites) one instance folder's instances.json.
pub fn write_one(instance_dir: &Path, instance: &Instance) -> Result<(), String> {
    std::fs::create_dir_all(instance_dir)
        .map_err(|e| format!("Could not create instance folder: {e}"))?;
    let json = serde_json::to_string_pretty(&instance.to_disk())
        .map_err(|e| format!("Failed to serialize instance: {e}"))?;
    std::fs::write(instance_dir.join(META_FILE), json)
        .map_err(|e| format!("Failed to save instance: {e}"))
}

/// Deletes just the metadata file, so the folder (and everything inside it - saves, mods, etc.)
/// stops being treated as an instance without touching the actual game files.
pub fn forget_one(instance_dir: &Path) -> Result<(), String> {
    match std::fs::remove_file(instance_dir.join(META_FILE)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not remove instance metadata: {error}")),
    }
}

/// Scans the direct subfolders of `instances_root` for valid instances. Does not recurse.
pub fn scan_all(instances_root: &Path) -> Vec<Instance> {
    let Ok(entries) = std::fs::read_dir(instances_root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        match read_one(&path) {
            Ok(Some(instance)) => out.push(instance),
            Ok(None) => {}
            Err(error) => eprintln!("Skipped {}: {error}", path.display()),
        }
    }
    out
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
