use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{fs, path::{Path, PathBuf}};

#[derive(Serialize)]
pub struct Screenshot { name: String, data_url: String }
#[derive(Serialize)]
pub struct World { name: String, icon: String, modified: u64 }
#[derive(Serialize, Deserialize, Default)]
pub struct Playtime { total_seconds: u64, days: Vec<PlaytimeDay> }
#[derive(Serialize, Deserialize)]
pub struct PlaytimeDay { date: String, seconds: u64 }

fn child_dir(root: &Path, name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name == "." || name == ".." { return Err("Invalid instance or world name".into()); }
    let root = root.canonicalize().map_err(|e| format!("Could not resolve world folder: {e}"))?;
    let path = root.join(name).canonicalize().map_err(|e| format!("Could not find world: {e}"))?;
    if path.parent() != Some(root.as_path()) || !path.is_dir() { return Err("World must be a folder inside this instance's saves directory".into()); }
    Ok(path)
}

pub fn screenshots(root: &Path) -> Result<Vec<Screenshot>, String> {
    let dir = root.join("screenshots");
    let mut out = Vec::new();
    let entries = match fs::read_dir(dir) { Ok(entries) => entries, Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out), Err(e) => return Err(e.to_string()) };
    for item in entries.flatten() {
        let path = item.path();
        let mime = match path.extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase().as_str() { "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", _ => continue };
        if !item.file_type().map(|kind| kind.is_file()).unwrap_or(false) { continue; }
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        out.push(Screenshot { name: item.file_name().to_string_lossy().into_owned(), data_url: format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)) });
    }
    out.sort_by(|a,b| b.name.cmp(&a.name));
    Ok(out)
}

pub fn worlds(root: &Path) -> Result<Vec<World>, String> {
    let dir = root.join("saves"); let mut out = Vec::new();
    let entries = match fs::read_dir(dir) { Ok(entries) => entries, Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out), Err(e) => return Err(e.to_string()) };
    for item in entries.flatten() {
        let path = item.path(); if !path.is_dir() || !path.join("level.dat").is_file() { continue; }
        let name = item.file_name().to_string_lossy().into_owned();
        let icon_path = path.join("icon.png");
        let icon = if let Ok(bytes) = fs::read(icon_path) { format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)) } else { String::new() };
        let modified = path.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
        out.push(World { name, icon, modified });
    }
    out.sort_by(|a,b| b.modified.cmp(&a.modified)); Ok(out)
}

pub fn read_nbt(root: &Path, world: &str) -> Result<String, String> {
    let path = child_dir(&root.join("saves"), world)?.join("level.dat");
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let mut decoder = flate2::read::GzDecoder::new(bytes.as_slice()); let mut raw = Vec::new();
    std::io::Read::read_to_end(&mut decoder, &mut raw).map_err(|e| format!("Could not decompress level.dat: {e}"))?;
    let value: fastnbt::Value = fastnbt::from_bytes(&raw).map_err(|e| format!("Could not parse level.dat: {e}"))?;
    serde_json::to_string_pretty(&value).map_err(|e| e.to_string())
}

pub fn write_nbt(root: &Path, world: &str, json: &str) -> Result<(), String> {
    let value: fastnbt::Value = serde_json::from_str(json).map_err(|e| format!("Invalid NBT JSON: {e}"))?;
    let raw = fastnbt::to_bytes(&value).map_err(|e| format!("Could not encode NBT: {e}"))?;
    let path = child_dir(&root.join("saves"), world)?.join("level.dat");
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    std::io::Write::write_all(&mut encoder, &raw).map_err(|e| e.to_string())?;
    let compressed = encoder.finish().map_err(|e| e.to_string())?;
    let backup = path.with_file_name("level.dat.arca-backup");
    if !backup.exists() { fs::copy(&path, backup).map_err(|e| format!("Could not create a level.dat backup: {e}"))?; }
    fs::write(path, compressed).map_err(|e| e.to_string())
}

pub fn playtime(root: &Path) -> Result<Playtime, String> {
    let path = root.join(".arca-playtime.json");
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("Could not read playtime history: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Playtime::default()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn record_session(root: &Path, started: std::time::SystemTime, ended: std::time::SystemTime) {
    let seconds = ended.duration_since(started).unwrap_or_default().as_secs();
    if seconds == 0 { return; }
    let mut data = playtime(root).unwrap_or_default();
    data.total_seconds = data.total_seconds.saturating_add(seconds);
    let mut cursor = started;
    while cursor < ended {
        let elapsed = cursor.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
        let day_number = elapsed / 86400;
        let chunk = (ended.duration_since(cursor).unwrap_or_default().as_secs()).min(86400 - (elapsed % 86400));
        if chunk == 0 { break; }
        let date = civil_date(day_number);
        if let Some(day) = data.days.iter_mut().find(|day| day.date == date) { day.seconds = day.seconds.saturating_add(chunk); }
        else { data.days.push(PlaytimeDay { date, seconds: chunk }); }
        cursor += std::time::Duration::from_secs(chunk);
    }
    data.days.sort_by(|a,b| b.date.cmp(&a.date));
    if let Ok(json) = serde_json::to_vec_pretty(&data) { let _ = fs::write(root.join(".arca-playtime.json"), json); }
}

fn civil_date(days: u64) -> String {
    let z = days as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe/1460 + doe/36524 - doe/146096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365*yoe + yoe/4 - yoe/100);
    let mp = (5*doy + 2)/153;
    let d = doy - (153*mp+2)/5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    y += if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}")
}
