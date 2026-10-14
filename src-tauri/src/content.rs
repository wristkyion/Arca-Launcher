//! Lists, enables/disables, and deletes files already installed in an instance's
//! mods/resourcepacks/shaderpacks folders (as opposed to mods.rs, which downloads new ones).
use anyhow::{anyhow, Result};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Serialize, Clone)]
pub struct ContentItem {
    pub name: String,      // display name (without .disabled)
    pub file_name: String, // actual file name on disk right now
    pub enabled: bool,
    pub size: u64,
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

pub fn list(inst_dir: &Path, kind: &str) -> Result<Vec<ContentItem>> {
    let folder = folder_path(inst_dir, kind)?;
    let mut out = vec![];
    let Ok(rd) = fs::read_dir(&folder) else { return Ok(out) };
    for entry in rd.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().to_string();
        let lower = file_name.to_lowercase();
        let is_pack = kind != "mods" && (lower.ends_with(".zip") || lower.ends_with(".zip.disabled"));
        let is_mod = kind == "mods" && (lower.ends_with(".jar") || lower.ends_with(".jar.disabled"));
        if !is_pack && !is_mod {
            continue; // skip stray files like .DS_Store, config leftovers, etc.
        }
        let enabled = !lower.ends_with(".disabled");
        let name = if enabled { file_name.clone() } else { file_name.trim_end_matches(".disabled").to_string() };
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        out.push(ContentItem { name, file_name, enabled, size });
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
    fs::remove_file(folder.join(file_name)).map_err(|e| anyhow!("Could not delete {file_name}: {e}"))
}