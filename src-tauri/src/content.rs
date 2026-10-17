//! Lists, enables/disables, and deletes files already installed in an instance's
//! mods/resourcepacks/shaderpacks folders (as opposed to mods.rs, which downloads new ones).
use anyhow::{anyhow, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

const METADATA_FILE: &str = "installed-content.json";

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct ContentMetadata {
    pub project_id: String,
    pub project_name: String,
    pub source: String,
    pub icon: String,
    pub version: String,
    pub channel: String,
    pub dependency: bool,
}

#[derive(Serialize, Clone)]
pub struct ContentItem {
    pub name: String,
    pub file_name: String,
    pub enabled: bool,
    pub size: u64,
    pub icon: String,
    pub source: String,
    pub version: String,
    pub channel: String,
    pub dependency: bool,
    pub description: String,
}

fn folder_name(kind: &str) -> Result<&'static str> {
    match kind {
        "mods" => Ok("mods"),
        "resourcepacks" => Ok("resourcepacks"),
        "shaderpacks" => Ok("shaderpacks"),
        other => Err(anyhow!("Unknown content kind {other}")),
    }
}

pub fn folder_path(inst_dir: &Path, kind: &str) -> Result<PathBuf> {
    Ok(inst_dir.join(folder_name(kind)?))
}

/// Rejects anything that isn't a bare file name (no path traversal).
fn safe_file(name: &str) -> Result<()> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return Err(anyhow!("Invalid file name"));
    }
    Ok(())
}

fn metadata_path(inst_dir: &Path) -> PathBuf {
    inst_dir.join(METADATA_FILE)
}

fn canonical_name(file_name: &str) -> &str {
    file_name.strip_suffix(".disabled").unwrap_or(file_name)
}

fn load_metadata(inst_dir: &Path) -> Result<HashMap<String, HashMap<String, ContentMetadata>>> {
    let path = metadata_path(inst_dir);
    match fs::read_to_string(&path) {
        Ok(contents) => Ok(serde_json::from_str(&contents)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(error) => Err(error.into()),
    }
}

fn save_metadata(
    inst_dir: &Path,
    metadata: &HashMap<String, HashMap<String, ContentMetadata>>,
) -> Result<()> {
    fs::write(
        metadata_path(inst_dir),
        serde_json::to_vec_pretty(metadata)?,
    )?;
    Ok(())
}

pub fn record(
    inst_dir: &Path,
    kind: &str,
    items: impl IntoIterator<Item = (String, ContentMetadata)>,
) -> Result<()> {
    let folder = folder_name(kind)?;
    let mut metadata = load_metadata(inst_dir)?;
    let entries = metadata.entry(folder.to_string()).or_default();
    for (file_name, item) in items {
        safe_file(&file_name)?;
        entries.insert(canonical_name(&file_name).to_string(), item);
    }
    save_metadata(inst_dir, &metadata)
}

fn pack_metadata(path: &Path) -> (String, String) {
    let Ok(file) = fs::File::open(path) else {
        return (String::new(), String::new());
    };
    let Ok(mut archive) = zip::ZipArchive::new(file) else {
        return (String::new(), String::new());
    };
    let description = archive
        .by_name("pack.mcmeta")
        .ok()
        .and_then(|mut entry| {
            if entry.size() > 64 * 1024 {
                return None;
            }
            let mut contents = String::new();
            entry.read_to_string(&mut contents).ok()?;
            let value: Value = serde_json::from_str(&contents).ok()?;
            let description = &value["pack"]["description"];
            description
                .as_str()
                .map(str::to_string)
                .or_else(|| description["text"].as_str().map(str::to_string))
        })
        .unwrap_or_default();
    let icon = archive
        .by_name("pack.png")
        .ok()
        .and_then(|mut entry| {
            if entry.size() > 1024 * 1024 {
                return None;
            }
            let mut bytes = Vec::with_capacity(entry.size() as usize);
            entry.read_to_end(&mut bytes).ok()?;
            Some(format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            ))
        })
        .unwrap_or_default();
    (description, icon)
}

fn archive_image(archive: &mut zip::ZipArchive<fs::File>, path: &str) -> Option<String> {
    let path = path.trim_start_matches('/');
    if path.is_empty()
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return None;
    }
    let mut entry = archive.by_name(path).ok()?;
    if entry.size() > 1024 * 1024 {
        return None;
    }
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut bytes).ok()?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return None;
    }
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

fn mod_metadata(path: &Path) -> (String, String, String) {
    let Ok(file) = fs::File::open(path) else {
        return (String::new(), String::new(), String::new());
    };
    let Ok(mut archive) = zip::ZipArchive::new(file) else {
        return (String::new(), String::new(), String::new());
    };

    let mut name = String::new();
    let mut description = String::new();
    let mut icon_path = String::new();

    if let Ok(mut entry) = archive.by_name("fabric.mod.json") {
        if entry.size() <= 256 * 1024 {
            let mut contents = String::new();
            if entry.read_to_string(&mut contents).is_ok() {
                if let Ok(metadata) = serde_json::from_str::<Value>(&contents) {
                    name = metadata["name"].as_str().unwrap_or("").to_string();
                    description = metadata["description"].as_str().unwrap_or("").to_string();
                    let icon = &metadata["icon"];
                    icon_path = icon
                        .as_str()
                        .or_else(|| {
                            icon.as_object()
                                .and_then(|icons| icons.values().next()?.as_str())
                        })
                        .unwrap_or("")
                        .to_string();
                }
            }
        }
    }

    if let Ok(mut entry) = archive.by_name("mcmod.info") {
        if entry.size() <= 256 * 1024 {
            let mut contents = String::new();
            if entry.read_to_string(&mut contents).is_ok() {
                if let Ok(metadata) = serde_json::from_str::<Value>(&contents) {
                    let mods = metadata
                        .as_array()
                        .or_else(|| metadata["modList"].as_array());
                    if let Some(mod_info) = mods.and_then(|mods| mods.first()) {
                        if name.is_empty() {
                            name = mod_info["name"].as_str().unwrap_or("").to_string();
                        }
                        if description.is_empty() {
                            description =
                                mod_info["description"].as_str().unwrap_or("").to_string();
                        }
                        if icon_path.is_empty() {
                            icon_path = mod_info["logoFile"].as_str().unwrap_or("").to_string();
                        }
                    }
                }
            }
        }
    }

    if icon_path.is_empty() {
        if let Ok(mut entry) = archive.by_name("META-INF/mods.toml") {
            if entry.size() <= 256 * 1024 {
                let mut contents = String::new();
                if entry.read_to_string(&mut contents).is_ok() {
                    icon_path = contents
                        .lines()
                        .find_map(|line| {
                            let (key, value) = line.split_once('=')?;
                            (key.trim() == "logoFile").then(|| {
                                value
                                    .trim()
                                    .trim_matches('"')
                                    .trim_matches('\'')
                                    .to_string()
                            })
                        })
                        .unwrap_or_default();
                }
            }
        }
    }

    let icon = if icon_path.is_empty() {
        String::new()
    } else {
        archive_image(&mut archive, &icon_path).unwrap_or_default()
    };
    (name, description, icon)
}

pub fn list(inst_dir: &Path, kind: &str) -> Result<Vec<ContentItem>> {
    let folder = folder_path(inst_dir, kind)?;
    let metadata = load_metadata(inst_dir)?
        .remove(folder_name(kind)?)
        .unwrap_or_default();
    let mut out = vec![];
    let rd = match fs::read_dir(&folder) {
        Ok(rd) => rd,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(error) => return Err(error.into()),
    };
    for entry in rd {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().to_string();
        let lower = file_name.to_lowercase();
        let is_pack =
            kind != "mods" && (lower.ends_with(".zip") || lower.ends_with(".zip.disabled"));
        let is_mod =
            kind == "mods" && (lower.ends_with(".jar") || lower.ends_with(".jar.disabled"));
        if !is_pack && !is_mod {
            continue; // skip stray files like .DS_Store, config leftovers, etc.
        }
        let enabled = !lower.ends_with(".disabled");
        let original_name = canonical_name(&file_name);
        let size = entry.metadata()?.len();
        let saved = metadata.get(original_name).cloned().unwrap_or_default();
        let mut name = saved.project_name.clone();
        let mut description = String::new();
        let mut icon = saved.icon.clone();
        if kind == "mods" && original_name.to_lowercase().ends_with(".jar") {
            let (mod_name, mod_description, mod_icon) = mod_metadata(&path);
            if name.is_empty() {
                name = mod_name;
            }
            description = mod_description;
            if icon.is_empty() {
                icon = mod_icon;
            }
        } else if kind != "mods" && original_name.to_lowercase().ends_with(".zip") {
            let (pack_description, pack_icon) = pack_metadata(&path);
            description = pack_description;
            if !pack_icon.is_empty() {
                icon = pack_icon;
            }
            if name.is_empty() {
                name = original_name
                    .strip_suffix(".zip")
                    .unwrap_or(original_name)
                    .to_string();
            }
        }
        if name.is_empty() {
            name = original_name
                .rsplit_once('.')
                .map_or(original_name, |(stem, _)| stem)
                .to_string();
        }
        out.push(ContentItem {
            name,
            file_name,
            enabled,
            size,
            icon,
            source: saved.source,
            version: saved.version,
            channel: saved.channel,
            dependency: saved.dependency,
            description,
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

/// Enable/disable by renaming to/from a `.disabled` suffix — same trick every launcher uses,
/// since Minecraft and mod loaders just ignore files with an unrecognized extension.
pub fn toggle(inst_dir: &Path, kind: &str, file_name: &str, enable: bool) -> Result<String> {
    safe_file(file_name)?;
    let folder = folder_path(inst_dir, kind)?;
    let from = folder.join(file_name);
    if !from.exists() {
        return Err(anyhow!("File not found: {file_name}"));
    }
    let new_name = if enable {
        file_name.trim_end_matches(".disabled").to_string()
    } else if file_name.ends_with(".disabled") {
        file_name.to_string()
    } else {
        format!("{file_name}.disabled")
    };
    if new_name != file_name {
        fs::rename(&from, folder.join(&new_name))?;
    }
    Ok(new_name)
}

pub fn delete(inst_dir: &Path, kind: &str, file_name: &str) -> Result<()> {
    safe_file(file_name)?;
    let folder = folder_path(inst_dir, kind)?;
    fs::remove_file(folder.join(file_name))
        .map_err(|e| anyhow!("Could not delete {file_name}: {e}"))?;
    let mut metadata = load_metadata(inst_dir)?;
    if let Some(entries) = metadata.get_mut(folder_name(kind)?) {
        entries.remove(canonical_name(file_name));
    }
    save_metadata(inst_dir, &metadata)
}

#[cfg(test)]
mod tests {
    use super::{list, record, ContentMetadata};
    use std::{
        fs,
        io::{Cursor, Write},
        path::PathBuf,
    };
    use zip::{write::SimpleFileOptions, ZipWriter};

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("arca-content-test-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn lists_modrinth_names_and_icons_from_saved_install_metadata() {
        let dir = temp_dir();
        let mods = dir.join("mods");
        fs::create_dir_all(&mods).unwrap();
        fs::write(mods.join("example-1.0.jar"), b"mod").unwrap();
        record(
            &dir,
            "mods",
            [(
                "example-1.0.jar".into(),
                ContentMetadata {
                    project_id: "project".into(),
                    project_name: "Example Mod".into(),
                    source: "modrinth".into(),
                    icon: "https://cdn.example/icon.png".into(),
                    version: "1.0".into(),
                    channel: "release".into(),
                    dependency: false,
                },
            )],
        )
        .unwrap();

        let items = list(&dir, "mods").unwrap();
        assert_eq!(items[0].name, "Example Mod");
        assert_eq!(items[0].source, "modrinth");
        assert_eq!(items[0].icon, "https://cdn.example/icon.png");
        assert_eq!(items[0].version, "1.0");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reads_resource_pack_description_and_artwork_from_zip() {
        let dir = temp_dir();
        let packs = dir.join("resourcepacks");
        fs::create_dir_all(&packs).unwrap();
        let archive = Cursor::new(Vec::new());
        let mut zip = ZipWriter::new(archive);
        zip.start_file("pack.mcmeta", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(br#"{"pack":{"description":"A sample pack"}} "#)
            .unwrap();
        zip.start_file("pack.png", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"image data").unwrap();
        let archive = zip.finish().unwrap().into_inner();
        fs::write(packs.join("sample.zip"), archive).unwrap();

        let items = list(&dir, "resourcepacks").unwrap();
        assert_eq!(items[0].name, "sample");
        assert_eq!(items[0].description, "A sample pack");
        assert!(items[0].icon.starts_with("data:image/png;base64,"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reads_mod_name_description_and_logo_from_fabric_jar() {
        let dir = temp_dir();
        let mods = dir.join("mods");
        fs::create_dir_all(&mods).unwrap();
        let archive = Cursor::new(Vec::new());
        let mut zip = ZipWriter::new(archive);
        zip.start_file("fabric.mod.json", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(
            br#"{"name":"Example Mod","description":"A test mod","icon":"assets/example/icon.png"}"#,
        )
        .unwrap();
        zip.start_file("assets/example/icon.png", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"\x89PNG\r\n\x1a\nexample image").unwrap();
        let archive = zip.finish().unwrap().into_inner();
        fs::write(mods.join("example-mod.jar"), archive).unwrap();

        let items = list(&dir, "mods").unwrap();
        assert_eq!(items[0].name, "Example Mod");
        assert_eq!(items[0].description, "A test mod");
        assert!(items[0].icon.starts_with("data:image/png;base64,"));
        fs::remove_dir_all(dir).unwrap();
    }
}
