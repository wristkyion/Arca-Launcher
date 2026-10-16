#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod accounts;
mod auth;
mod content;
mod game;
mod instances;
mod mods;

use accounts::{Store, Stored};
use anyhow::anyhow;
use base64::Engine;
use instances::Instance;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    io::Cursor,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Emitter};

pub fn emit(app: &AppHandle, msg: impl Into<String>) {
    let _ = app.emit("progress", msg.into());
}

const MAX_THEME_SIZE: u64 = 256 * 1024;

#[derive(Serialize)]
struct ThemeInfo {
    id: String,
    name: String,
    author: String,
    builtin: bool,
}

#[derive(Serialize)]
struct ThemeCatalog {
    themes: Vec<ThemeInfo>,
    warnings: Vec<String>,
}

#[derive(Serialize)]
struct ThemeStylesheet {
    id: String,
    name: String,
    author: String,
    css: String,
}

fn builtin_theme(id: &str) -> Option<ThemeStylesheet> {
    let (name, css) = match id {
        "builtin:default" => ("Default", include_str!("../../assets/themes/default.css")),
        "builtin:minimal" => ("Minimal", include_str!("../../assets/themes/minimal.css")),
        "builtin:minecraft" => (
            "Minecraft style",
            include_str!("../../assets/themes/minecraft.css"),
        ),
        _ => return None,
    };
    Some(ThemeStylesheet {
        id: id.to_string(),
        name: name.to_string(),
        author: "Arca Launcher".to_string(),
        css: css.to_string(),
    })
}

fn theme_metadata(css: &str, fallback_name: &str) -> (String, String) {
    let mut name = None;
    let mut author = None;
    let mut in_comment = false;
    for line in css.lines() {
        let mut text = line.trim();
        if !in_comment {
            if let Some(start) = text.find("/*") {
                text = &text[start + 2..];
                in_comment = true;
            } else {
                continue;
            }
        }
        if let Some(end) = text.find("*/") {
            text = &text[..end];
            in_comment = false;
        }
        let text = text.trim().trim_start_matches('*').trim();
        if let Some((key, value)) = text.split_once(':') {
            let value = value.trim();
            if !value.is_empty() {
                match key.trim().to_ascii_lowercase().as_str() {
                    "name" => name = Some(value.to_string()),
                    "author" => author = Some(value.to_string()),
                    _ => {}
                }
            }
        }
    }
    (
        name.unwrap_or_else(|| fallback_name.to_string()),
        author.unwrap_or_else(|| "Unknown".to_string()),
    )
}

fn strip_css_comments(css: &str) -> String {
    let mut output = String::with_capacity(css.len());
    let mut chars = css.chars().peekable();
    let mut quote = None;
    let mut escaped = false;
    while let Some(character) = chars.next() {
        if let Some(delimiter) = quote {
            output.push(character);
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == delimiter {
                quote = None;
            }
        } else if character == '"' || character == '\'' {
            quote = Some(character);
            output.push(character);
        } else if character == '/' && chars.peek() == Some(&'*') {
            chars.next();
            while let Some(character) = chars.next() {
                if character == '*' && chars.peek() == Some(&'/') {
                    chars.next();
                    break;
                }
            }
        } else {
            output.push(character);
        }
    }
    output
}

fn validate_theme_css(css: &str) -> Result<(), String> {
    if css.len() as u64 > MAX_THEME_SIZE {
        return Err("Theme CSS is larger than 256 KB".to_string());
    }
    let css = strip_css_comments(css);
    if css.contains('\\') {
        return Err("CSS escape sequences are not supported in custom themes".to_string());
    }
    let lower = css.to_ascii_lowercase();
    for blocked in [
        "@import",
        "url(",
        "image-set(",
        "-webkit-image-set(",
        "expression(",
        "javascript:",
        "behavior:",
        "-moz-binding",
    ] {
        if lower.contains(blocked) {
            return Err(format!("Theme CSS may not contain {blocked}"));
        }
    }
    Ok(())
}

fn custom_themes_dir() -> Result<PathBuf, String> {
    let (_, launcher, _) = setup_dirs();
    let themes = launcher.join("themes");
    std::fs::create_dir_all(&themes)
        .map_err(|error| format!("Could not create themes folder: {error}"))?;
    Ok(themes)
}

fn custom_theme_path(id: &str) -> Result<PathBuf, String> {
    let stem = id
        .strip_prefix("custom:")
        .filter(|stem| !stem.is_empty() && !stem.contains('/') && !stem.contains('\\'))
        .ok_or_else(|| "Invalid custom theme id".to_string())?;
    let themes_dir = custom_themes_dir()?;
    let canonical_dir = themes_dir
        .canonicalize()
        .map_err(|error| format!("Could not resolve themes folder: {error}"))?;
    let path = themes_dir.join(format!("{stem}.css"));
    let canonical_path = path
        .canonicalize()
        .map_err(|error| format!("Could not find custom theme: {error}"))?;
    if canonical_path.parent() != Some(canonical_dir.as_path()) {
        return Err("Custom theme must be a CSS file inside the themes folder".to_string());
    }
    Ok(canonical_path)
}

#[tauri::command]
fn list_themes() -> Result<ThemeCatalog, String> {
    let mut themes = [
        ("builtin:default", "Default"),
        ("builtin:minimal", "Minimal"),
        ("builtin:minecraft", "Minecraft style"),
    ]
    .into_iter()
    .map(|(id, name)| ThemeInfo {
        id: id.to_string(),
        name: name.to_string(),
        author: "Arca Launcher".to_string(),
        builtin: true,
    })
    .collect::<Vec<_>>();
    let mut warnings = Vec::new();
    let themes_dir = custom_themes_dir()?;
    let canonical_themes_dir = themes_dir
        .canonicalize()
        .map_err(|error| format!("Could not resolve themes folder: {error}"))?;
    let entries = std::fs::read_dir(&themes_dir)
        .map_err(|error| format!("Could not list themes folder: {error}"))?;
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                warnings.push(format!("Could not read a theme folder entry: {error}"));
                continue;
            }
        };
        let path = entry.path();
        if !path.is_file()
            || !path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("css"))
        {
            continue;
        }
        let stem = match path.file_stem().and_then(|name| name.to_str()) {
            Some(stem) if !stem.is_empty() => stem.to_string(),
            _ => {
                warnings.push(format!(
                    "Skipped a theme with an invalid filename: {}",
                    path.display()
                ));
                continue;
            }
        };
        let canonical_path = match path.canonicalize() {
            Ok(path) if path.parent() == Some(canonical_themes_dir.as_path()) => path,
            Ok(_) => {
                warnings.push(format!(
                    "{stem}.css points outside the themes folder and was skipped"
                ));
                continue;
            }
            Err(error) => {
                warnings.push(format!("Could not resolve {stem}.css: {error}"));
                continue;
            }
        };
        let size = match canonical_path.metadata() {
            Ok(metadata) => metadata.len(),
            Err(error) => {
                warnings.push(format!("Could not read {stem}.css metadata: {error}"));
                continue;
            }
        };
        if size > MAX_THEME_SIZE {
            warnings.push(format!("{stem}.css is larger than 256 KB and was skipped"));
            continue;
        }
        let css = match std::fs::read_to_string(&canonical_path) {
            Ok(css) => css,
            Err(error) => {
                warnings.push(format!("Could not read {stem}.css: {error}"));
                continue;
            }
        };
        if let Err(error) = validate_theme_css(&css) {
            warnings.push(format!("{stem}.css was skipped: {error}"));
            continue;
        }
        let (name, author) = theme_metadata(&css, &stem);
        themes.push(ThemeInfo {
            id: format!("custom:{stem}"),
            name,
            author,
            builtin: false,
        });
    }
    themes.sort_by(|a, b| {
        a.builtin
            .cmp(&b.builtin)
            .reverse()
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(ThemeCatalog { themes, warnings })
}

#[tauri::command]
fn load_theme(id: String) -> Result<ThemeStylesheet, String> {
    if let Some(theme) = builtin_theme(&id) {
        return Ok(theme);
    }
    let path = custom_theme_path(&id)?;
    let css = std::fs::read_to_string(&path)
        .map_err(|error| format!("Could not read custom theme: {error}"))?;
    validate_theme_css(&css)?;
    let stem = path
        .file_stem()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Custom theme filename is invalid".to_string())?;
    let (name, author) = theme_metadata(&css, stem);
    Ok(ThemeStylesheet {
        id,
        name,
        author,
        css,
    })
}

fn root_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Returns (game dir, launcher dir, config dir) and creates the folder layout.
fn setup_dirs() -> (PathBuf, PathBuf, PathBuf) {
    let root = root_dir();
    let game = root.join("game");
    let launcher = root.join("launcher");
    let config = launcher.join("config");
    for d in [&game, &config, &root.join("jre").join("javaruntime")] {
        let _ = std::fs::create_dir_all(d);
    }
    (game, launcher, config)
}

#[tauri::command]
fn load_settings() -> Result<Value, String> {
    let (_, _, cfg) = setup_dirs();
    let mut settings = match std::fs::read_to_string(cfg.join("settings.json")) {
        Ok(data) => {
            serde_json::from_str(&data).map_err(|e| format!("Could not parse settings: {e}"))?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(error) => return Err(format!("Could not read settings: {error}")),
    };
    let instance_directory = instance_root()?;
    settings
        .as_object_mut()
        .ok_or_else(|| "Settings must be a JSON object".to_string())?
        .entry("settings")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| "Settings preferences must be a JSON object".to_string())?
        .insert(
            "instanceDirectory".into(),
            serde_json::Value::String(instance_directory.to_string_lossy().into_owned()),
        );
    Ok(settings)
}

#[tauri::command]
fn save_settings(data: Value) -> Result<(), String> {
    let (_, _, cfg) = setup_dirs();
    let settings = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("Could not serialize settings: {e}"))?;
    std::fs::write(cfg.join("settings.json"), settings)
        .map_err(|e| format!("Could not write settings: {e}"))
}

pub(crate) fn instance_root() -> Result<PathBuf, String> {
    let (game, _, cfg) = setup_dirs();
    let settings_path = cfg.join("settings.json");
    let data = match std::fs::read_to_string(&settings_path) {
        Ok(contents) => serde_json::from_str::<Value>(&contents)
            .map_err(|e| format!("Could not parse settings: {e}"))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(error) => return Err(format!("Could not read settings: {error}")),
    };
    let configured = data
        .get("settings")
        .and_then(|settings| settings.get("instanceDirectory"))
        .and_then(Value::as_str)
        .filter(|path| !path.trim().is_empty());
    let path = configured
        .map(PathBuf::from)
        .unwrap_or_else(|| game.join("instances"));
    if !path.is_absolute() {
        return Err("The instance folder path must be absolute".into());
    }
    Ok(path)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InstanceDirectoryResult {
    path: String,
    warning: Option<String>,
}

fn copy_directory_contents(
    source: &Path,
    destination: &Path,
    created: &mut Vec<PathBuf>,
) -> Result<(), String> {
    for entry in
        std::fs::read_dir(source).map_err(|e| format!("Could not read instance folder: {e}"))?
    {
        let entry = entry.map_err(|e| format!("Could not read instance folder entry: {e}"))?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Could not inspect {}: {e}", source_path.display()))?;
        if file_type.is_dir() {
            std::fs::create_dir(&destination_path)
                .map_err(|e| format!("Could not create {}: {e}", destination_path.display()))?;
            created.push(destination_path.clone());
            copy_directory_contents(&source_path, &destination_path, created)?;
        } else if file_type.is_file() {
            let mut input = std::fs::File::open(&source_path)
                .map_err(|e| format!("Could not read {}: {e}", source_path.display()))?;
            let mut output = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&destination_path)
                .map_err(|e| format!("Could not create {}: {e}", destination_path.display()))?;
            created.push(destination_path.clone());
            std::io::copy(&mut input, &mut output)
                .map_err(|e| format!("Could not copy {}: {e}", source_path.display()))?;
        } else {
            return Err(format!(
                "Unsupported file type in instance folder: {}",
                source_path.display()
            ));
        }
    }
    Ok(())
}

fn remove_copied_paths(paths: &[PathBuf]) -> Result<(), String> {
    for path in paths.iter().rev() {
        let file_type = match std::fs::symlink_metadata(path) {
            Ok(metadata) => metadata.file_type(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("Could not inspect {}: {error}", path.display())),
        };
        if file_type.is_dir() {
            std::fs::remove_dir_all(path)
                .map_err(|e| format!("Could not remove {}: {e}", path.display()))?;
        } else {
            match std::fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(format!("Could not remove {}: {error}", path.display())),
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn set_instance_directory(path: String) -> Result<InstanceDirectoryResult, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("Choose an instance folder first".into());
    }
    let requested = PathBuf::from(path);
    if !requested.is_absolute() {
        return Err("The instance folder path must be absolute".into());
    }
    std::fs::create_dir_all(&requested)
        .map_err(|e| format!("Could not create instance folder: {e}"))?;
    let destination = std::fs::canonicalize(&requested)
        .map_err(|e| format!("Could not resolve instance folder: {e}"))?;
    let source = instance_root()?;
    std::fs::create_dir_all(&source)
        .map_err(|e| format!("Could not create current instance folder: {e}"))?;
    let source = std::fs::canonicalize(&source)
        .map_err(|e| format!("Could not resolve current instance folder: {e}"))?;
    if source == destination {
        return Ok(InstanceDirectoryResult {
            path: destination.to_string_lossy().into_owned(),
            warning: None,
        });
    }
    if source.starts_with(&destination) || destination.starts_with(&source) {
        return Err(
            "The new instance folder cannot contain, or be inside, the current instance folder"
                .into(),
        );
    }
    if std::fs::read_dir(&destination)
        .map_err(|e| format!("Could not inspect instance folder: {e}"))?
        .next()
        .is_some()
    {
        return Err("Choose an empty folder so existing instances can be moved safely".into());
    }

    let (_, _, cfg) = setup_dirs();
    let settings_path = cfg.join("settings.json");
    let mut data = match std::fs::read_to_string(&settings_path) {
        Ok(contents) => serde_json::from_str::<Value>(&contents)
            .map_err(|e| format!("Could not parse settings: {e}"))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(error) => return Err(format!("Could not read settings: {error}")),
    };
    let settings = data
        .as_object_mut()
        .ok_or_else(|| "Settings must be a JSON object".to_string())?
        .entry("settings")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| "Settings preferences must be a JSON object".to_string())?;
    settings.insert(
        "instanceDirectory".into(),
        serde_json::Value::String(destination.to_string_lossy().into_owned()),
    );
    let serialized = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("Could not serialize settings: {e}"))?;

    let mut copied_paths = Vec::new();
    if let Err(error) = copy_directory_contents(&source, &destination, &mut copied_paths) {
        let cleanup = remove_copied_paths(&copied_paths).err();
        return Err(match cleanup {
            Some(cleanup_error) => format!("{error}; partial copy cleanup failed: {cleanup_error}"),
            None => error,
        });
    }

    if let Err(error) = std::fs::write(&settings_path, serialized) {
        let cleanup = remove_copied_paths(&copied_paths).err();
        return Err(match cleanup {
            Some(cleanup_error) => format!("Could not save instance folder setting: {error}; partial copy cleanup failed: {cleanup_error}"),
            None => format!("Could not save instance folder setting: {error}"),
        });
    }

    let warning = std::fs::remove_dir_all(&source)
        .err()
        .map(|e| format!("New folder is active, but old instance files could not be removed: {e}"));
    Ok(InstanceDirectoryResult {
        path: destination.to_string_lossy().into_owned(),
        warning,
    })
}

fn java_major_for_minecraft(version: &str) -> u8 {
    let mut parts = version
        .split('.')
        .filter_map(|part| part.parse::<u16>().ok());
    let Some(first) = parts.next() else {
        return 21;
    };
    if first >= 26 {
        return 25;
    }
    let Some(minor) = parts.next() else {
        return 21;
    };
    let patch = parts.next().unwrap_or_default();
    if minor > 20 || (minor == 20 && patch >= 5) {
        21
    } else if minor >= 18 {
        17
    } else if minor == 17 {
        16
    } else {
        8
    }
}

fn launcher_java_path(major: u8) -> PathBuf {
    root_dir()
        .join("jre")
        .join("javaruntime")
        .join(format!("java-{major}"))
        .join("bin")
        .join(if cfg!(windows) { "java.exe" } else { "java" })
}

async fn ensure_launcher_java(app: &AppHandle, mc_version: &str) -> anyhow::Result<PathBuf> {
    if !cfg!(all(windows, target_arch = "x86_64")) {
        anyhow::bail!("Launcher-managed Java downloads currently support Windows x64 only.");
    }
    let major = java_major_for_minecraft(mc_version);
    let java_path = launcher_java_path(major);
    if java_path.is_file() {
        return Ok(java_path);
    }

    let runtime_root = root_dir().join("jre").join("javaruntime");
    std::fs::create_dir_all(&runtime_root)?;
    let staging = runtime_root.join(format!("java-{major}-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir(&staging)?;
    emit(
        app,
        format!("Downloading Java {major} for Minecraft {mc_version}..."),
    );

    let result = async {
        let url = format!(
            "https://api.adoptium.net/v3/binary/latest/{major}/ga/windows/x64/jre/hotspot/normal/eclipse"
        );
        let response = game::http().get(url).send().await?.error_for_status()?;
        let archive_bytes = response.bytes().await?;
        let mut archive = zip::ZipArchive::new(Cursor::new(archive_bytes))?;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index)?;
            let Some(relative) = entry.enclosed_name() else {
                anyhow::bail!("Java archive contains an unsafe path");
            };
            let mut components = relative.components();
            components.next();
            let relative = components.as_path();
            if relative.as_os_str().is_empty() {
                continue;
            }
            let destination = staging.join(relative);
            if entry.is_dir() {
                std::fs::create_dir_all(&destination)?;
                continue;
            }
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut output = std::fs::File::create(destination)?;
            std::io::copy(&mut entry, &mut output)?;
        }

        let extracted_java = staging.join("bin").join("java.exe");
        if !extracted_java.is_file() {
            anyhow::bail!("Downloaded Java archive did not contain bin/java.exe");
        }
        let install_dir = runtime_root.join(format!("java-{major}"));
        match std::fs::rename(&staging, &install_dir) {
            Ok(()) => {}
            Err(_error) if install_dir.join("bin").join("java.exe").is_file() => {
                std::fs::remove_dir_all(&staging)
                    .map_err(|error| anyhow!("Java is installed, but temporary files could not be removed: {error}"))?;
            }
            Err(error) => return Err(error.into()),
        }
        emit(app, format!("Java {major} is ready"));
        Ok::<(), anyhow::Error>(())
    }
    .await;

    if let Err(error) = result {
        let cleanup = std::fs::remove_dir_all(&staging).err();
        return Err(match cleanup {
            Some(cleanup_error) => {
                anyhow!("{error}; could not clean temporary Java files: {cleanup_error}")
            }
            None => error,
        });
    }
    Ok(java_path)
}

pub(crate) async fn pick_java(
    app: &AppHandle,
    user: &str,
    runtime_mode: &str,
    mc_version: &str,
) -> anyhow::Result<String> {
    let user = user.trim();
    if !user.is_empty() && user != "java" {
        return Ok(user.to_string());
    }
    match runtime_mode {
        "system" => Ok("java".into()),
        "launcher" => Ok(ensure_launcher_java(app, mc_version)
            .await?
            .to_string_lossy()
            .into_owned()),
        other => anyhow::bail!("Unknown Java runtime option: {other}"),
    }
}

#[tauri::command]
async fn download_java_runtime(app: AppHandle, mc_version: String) -> Result<String, String> {
    ensure_launcher_java(&app, &mc_version)
        .await
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| format!("{error:#}"))
}

fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

// ------------------------------------------------------------ instance content

#[derive(Deserialize)]
struct ContentReq {
    instance: String,
    kind: String,
}

fn instance_dir(id: &str) -> Result<PathBuf, String> {
    let (_, _, cfg) = setup_dirs();
    let inst = instances::load(&cfg)
        .into_iter()
        .find(|i| i.id == id)
        .ok_or("Instance not found")?;
    Ok(instance_root()?.join(&inst.id))
}

#[tauri::command]
fn list_content(req: ContentReq) -> Result<Vec<content::ContentItem>, String> {
    content::list(&instance_dir(&req.instance)?, &req.kind).map_err(|e| format!("{e:#}"))
}

#[derive(Deserialize)]
struct ToggleContentReq {
    instance: String,
    kind: String,
    file_name: String,
    enable: bool,
}

#[tauri::command]
fn toggle_content(req: ToggleContentReq) -> Result<String, String> {
    content::toggle(
        &instance_dir(&req.instance)?,
        &req.kind,
        &req.file_name,
        req.enable,
    )
    .map_err(|e| format!("{e:#}"))
}

#[derive(Deserialize)]
struct DeleteContentReq {
    instance: String,
    kind: String,
    file_name: String,
}

#[tauri::command]
fn delete_content(req: DeleteContentReq) -> Result<(), String> {
    content::delete(&instance_dir(&req.instance)?, &req.kind, &req.file_name)
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn open_instance_folder(req: ContentReq) -> Result<(), String> {
    let folder = content::folder_path(&instance_dir(&req.instance)?, &req.kind)
        .map_err(|e| format!("{e:#}"))?;
    std::fs::create_dir_all(&folder)
        .map_err(|e| format!("Could not create content folder: {e}"))?;
    #[cfg(windows)]
    std::process::Command::new("explorer")
        .arg(&folder)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&folder)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(&folder)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ------------------------------------------------------------ accounts

#[derive(Serialize)]
struct AccountView {
    id: String,
    kind: String,
    username: String,
    uuid: String,
}

#[derive(Serialize)]
struct AccountList {
    selected: Option<String>,
    accounts: Vec<AccountView>,
}

fn view(s: &Store) -> AccountList {
    AccountList {
        selected: s.selected.clone(),
        accounts: s
            .accounts
            .iter()
            .map(|a| AccountView {
                id: a.id.clone(),
                kind: a.kind.clone(),
                username: a.username.clone(),
                uuid: a.uuid.clone(),
            })
            .collect(),
    }
}

#[derive(Deserialize)]
struct AddReq {
    kind: String,
    username: String,
    password: String,
    ms_client_id: String,
}

#[tauri::command]
fn list_accounts() -> AccountList {
    let (_, _, cfg) = setup_dirs();
    view(&accounts::load(&cfg))
}

#[tauri::command]
fn select_account(id: String) -> Result<AccountList, String> {
    let (_, _, cfg) = setup_dirs();
    let mut s = accounts::load(&cfg);
    if !s.accounts.iter().any(|a| a.id == id) {
        return Err("Account not found".into());
    }
    s.selected = Some(id);
    accounts::save(&cfg, &s);
    Ok(view(&s))
}

#[tauri::command]
fn remove_account(id: String) -> Result<AccountList, String> {
    let (_, _, cfg) = setup_dirs();
    let mut s = accounts::load(&cfg);
    s.accounts.retain(|a| a.id != id);
    if s.selected.as_deref() == Some(id.as_str()) {
        s.selected = s.accounts.first().map(|a| a.id.clone());
    }
    accounts::save(&cfg, &s);
    Ok(view(&s))
}

#[tauri::command]
async fn add_account(app: AppHandle, req: AddReq) -> Result<AccountList, String> {
    add(app, req).await.map_err(|e| format!("{e:#}"))
}

async fn add(app: AppHandle, req: AddReq) -> anyhow::Result<AccountList> {
    let (_, launcher_dir, cfg) = setup_dirs();
    let mut store = accounts::load(&cfg);

    let stored = match req.kind.as_str() {
        // instant
        "offline" => {
            let n = req.username.trim();
            if n.len() < 3
                || n.len() > 16
                || !n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            {
                anyhow::bail!("Username must be 3-16 characters: letters, numbers or _");
            }
            let a = auth::offline(n);
            Stored {
                id: new_id(),
                kind: "offline".into(),
                username: a.username,
                uuid: a.uuid,
                ..Default::default()
            }
        }
        // password login, then save the token
        "elyby" => {
            if req.username.trim().is_empty() || req.password.is_empty() {
                anyhow::bail!("Enter your Ely.by username and password");
            }
            let client_token = new_id();
            let a = auth::ely_login(
                &launcher_dir,
                req.username.trim(),
                &req.password,
                &client_token,
            )
            .await?;
            Stored {
                id: new_id(),
                kind: "elyby".into(),
                username: a.username,
                uuid: a.uuid,
                access_token: a.token,
                client_token,
                ..Default::default()
            }
        }
        // device-code login, then save the refresh token
        "microsoft" => {
            if req.ms_client_id.trim().is_empty() {
                anyhow::bail!("Enter your Azure client ID first (Settings tab)");
            }
            let (a, rt) = auth::ms_new(&app, req.ms_client_id.trim()).await?;
            Stored {
                id: new_id(),
                kind: "microsoft".into(),
                username: a.username,
                uuid: a.uuid,
                refresh_token: rt,
                ..Default::default()
            }
        }
        k => anyhow::bail!("Unknown account type {k}"),
    };

    // same account added twice -> update it instead of duplicating
    let pos = store
        .accounts
        .iter()
        .position(|x| x.kind == stored.kind && x.uuid == stored.uuid);
    let id = match pos {
        Some(i) => {
            let id = store.accounts[i].id.clone();
            store.accounts[i] = Stored {
                id: id.clone(),
                ..stored
            };
            id
        }
        None => {
            let id = stored.id.clone();
            store.accounts.push(stored);
            id
        }
    };
    store.selected = Some(id);
    accounts::save(&cfg, &store);
    Ok(view(&store))
}

// ------------------------------------------------------------ skins

#[derive(Serialize)]
struct Skin {
    url: String,
    slim: bool,
    data: String, // data:image/png;base64,...
}

/// Looks up the skin texture on the account's own skin server.
#[tauri::command]
async fn get_skin(kind: String, username: String, uuid: String) -> Option<Skin> {
    fetch_skin(&kind, &username, &uuid).await.ok().flatten()
}

async fn fetch_skin(kind: &str, username: &str, uuid: &str) -> anyhow::Result<Option<Skin>> {
    let c = game::http();
    let textures: serde_json::Value = match kind {
        "elyby" => {
            let r = c
                .get(format!("https://skinsystem.ely.by/textures/{username}"))
                .send()
                .await?;
            if !r.status().is_success() {
                return Ok(None);
            }
            r.json().await?
        }
        "microsoft" => {
            let r = c
                .get(format!(
                    "https://sessionserver.mojang.com/session/minecraft/profile/{uuid}"
                ))
                .send()
                .await?;
            if !r.status().is_success() {
                return Ok(None);
            }
            let v: serde_json::Value = r.json().await?;
            let b64 = v["properties"]
                .as_array()
                .and_then(|a| a.iter().find(|p| p["name"] == "textures"))
                .and_then(|p| p["value"].as_str())
                .ok_or_else(|| anyhow!("no textures"))?;
            let bytes = base64::engine::general_purpose::STANDARD.decode(b64)?;
            serde_json::from_slice::<serde_json::Value>(&bytes)?["textures"].clone()
        }
        _ => return Ok(None),
    };
    let skin = &textures["SKIN"];
    let Some(url) = skin["url"].as_str() else {
        return Ok(None);
    };
    let url = url.replacen("http://", "https://", 1);
    let png = c
        .get(&url)
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?;
    let data = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&png)
    );
    Ok(Some(Skin {
        url,
        slim: skin["metadata"]["model"] == "slim",
        data,
    }))
}

// ------------------------------------------------------------ playing

#[derive(Deserialize)]
struct PlayReq {
    instance: String,
    ram: u32,
    java: String,
    #[serde(default = "default_java_runtime")]
    java_mode: String,
    ms_client_id: String,
    jvm_args: String,
    game_args: String,
    hide: String,
    volume: Option<u32>,
}

fn default_java_runtime() -> String {
    "system".into()
}

/// Splits "-Dfoo=bar --name "my name"" into arguments (double quotes group words).
fn split_args(s: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut quoted = false;
    for ch in s.chars() {
        match ch {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Version list from Mojang's server (cached, so it still works offline).
#[tauri::command]
async fn mc_versions() -> Result<Vec<game::VersionInfo>, String> {
    let (_, _, cfg) = setup_dirs();
    let cache = cfg.join("versions-cache.json");
    match game::mc_versions().await {
        Ok(v) => {
            let _ = std::fs::write(&cache, serde_json::to_string(&v).unwrap());
            Ok(v)
        }
        Err(e) => std::fs::read_to_string(&cache)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .ok_or_else(|| format!("{e:#}")),
    }
}

/// Total system memory in MB (for the "auto RAM" setting).
#[tauri::command]
fn system_ram() -> u64 {
    let mut s = sysinfo::System::new();
    s.refresh_memory();
    s.total_memory() / 1024 / 1024
}

#[tauri::command]
async fn play(app: AppHandle, req: PlayReq) -> Result<(), String> {
    run(app, req).await.map_err(|e| format!("{e:#}"))
}

async fn run(app: AppHandle, req: PlayReq) -> anyhow::Result<()> {
    let (dir, launcher_dir, cfg) = setup_dirs();
    let c = game::http();

    // 0. The instance to launch
    let rec = instances::load(&cfg)
        .into_iter()
        .find(|i| i.id == req.instance)
        .ok_or_else(|| anyhow!("Select an instance first"))?;
    let java = pick_java(&app, &req.java, &req.java_mode, &rec.mc).await?;
    let id = rec.version_id.clone();
    if !dir
        .join("versions")
        .join(&id)
        .join(format!("{id}.json"))
        .exists()
    {
        anyhow::bail!("The files for this instance are missing. Delete it and download it again.");
    }

    // 1. Use the selected saved account (refreshing its token if needed)
    emit(&app, "Logging in...");
    let mut store = accounts::load(&cfg);
    let sel = store
        .selected
        .clone()
        .ok_or_else(|| anyhow!("Add an account first (Account tab)"))?;
    let idx = store
        .accounts
        .iter()
        .position(|a| a.id == sel)
        .ok_or_else(|| anyhow!("Selected account not found"))?;
    let saved = store.accounts[idx].clone();
    let account = match saved.kind.as_str() {
        "offline" => auth::offline(&saved.username),
        "elyby" => {
            let a = auth::ely_session(
                &launcher_dir,
                &saved.username,
                &saved.uuid,
                &saved.access_token,
                &saved.client_token,
            )
            .await?;
            store.accounts[idx].access_token = a.token.clone();
            a
        }
        "microsoft" => {
            if req.ms_client_id.trim().is_empty() {
                anyhow::bail!("Enter your Azure client ID (Settings tab)");
            }
            let (a, rt) = auth::ms_resume(req.ms_client_id.trim(), &saved.refresh_token).await?;
            store.accounts[idx].refresh_token = rt;
            store.accounts[idx].username = a.username.clone();
            a
        }
        k => anyhow::bail!("Unknown account type {k}"),
    };
    accounts::save(&cfg, &store);
    emit(&app, format!("Logged in as {}", account.username));

    // 2. Make sure libraries and assets are all there (already-downloaded files are skipped)
    let v = game::resolve(&dir, &id)?;
    let inst = instance_root()
        .map_err(|error| anyhow!(error))?
        .join(&rec.id);
    game::prepare_instance(&inst)?;
    game::install_deps(&app, &c, &dir, &id, &v, &inst).await?;

    // 3. Launch
    emit(&app, format!("Launching {}", rec.name));
    let opts = game::LaunchOpts {
        jvm_args: split_args(&req.jvm_args),
        game_args: split_args(&req.game_args),
        hide: req.hide.clone(),
        volume: req.volume,
    };
    game::launch(&app, &dir, &id, &v, &account, req.ram, &java, &inst, &opts)
}

// ------------------------------------------------------------ instances

fn slug(name: &str) -> String {
    let mut s = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c.to_ascii_lowercase());
        } else if !s.is_empty() && !s.ends_with('-') {
            s.push('-');
        }
    }
    let s = s.trim_matches('-').to_string();
    if s.is_empty() {
        "instance".into()
    } else {
        s
    }
}

#[tauri::command]
fn list_instances() -> Result<Vec<Instance>, String> {
    let (_, _, cfg) = setup_dirs();
    let root = instance_root()?;
    let mut list = instances::load(&cfg);
    let mut migrated = false;
    for instance in &mut list {
        if instance.background.starts_with("data:image/") {
            let path = root.join(&instance.id);
            instance.background = instances::save_background(&path, &instance.background)?;
            migrated = true;
        }
    }
    if migrated {
        instances::save(&cfg, &list)?;
    }
    Ok(list)
}

#[tauri::command]
fn load_instance_background(id: String) -> Result<Option<String>, String> {
    let (_, _, cfg) = setup_dirs();
    let root = instance_root()?;
    let instance = instances::load(&cfg)
        .into_iter()
        .find(|instance| instance.id == id)
        .ok_or_else(|| "Instance not found".to_string())?;
    let path = root.join(&instance.id);
    instances::read_background(&path, &instance.background)
}

#[tauri::command]
async fn loader_support(mc: String) -> Vec<String> {
    game::loader_support(&mc).await
}

#[derive(Deserialize)]
struct CreateReq {
    name: String,
    loader: String,
    mc: String,
    java: String,
    #[serde(default = "default_java_runtime")]
    java_mode: String,
    icon: String,
    description: String,
    background: String,
}

#[tauri::command]
async fn create_instance(app: AppHandle, req: CreateReq) -> Result<Vec<Instance>, String> {
    create(app, req).await.map_err(|e| format!("{e:#}"))
}

async fn create(app: AppHandle, req: CreateReq) -> anyhow::Result<Vec<Instance>> {
    let name = req.name.trim().to_string();
    if name.is_empty() {
        anyhow::bail!("Give the instance a name");
    }
    let (dir, _, cfg) = setup_dirs();
    let instance_root = instance_root().map_err(|error| anyhow!(error))?;
    let c = game::http();
    let java = pick_java(&app, &req.java, &req.java_mode, &req.mc).await?;

    emit(&app, "Creating instance...");
    game::install_vanilla(&app, &c, &dir, &req.mc).await?;
    let version_id = game::install_loader(&app, &c, &dir, &req.loader, &req.mc, &java).await?;
    let v = game::resolve(&dir, &version_id)?;

    let mut list = instances::load(&cfg);
    let base = slug(&name);
    let mut id = base.clone();
    let mut n = 2;
    while list.iter().any(|i| i.id == id) || instance_root.join(&id).exists() {
        id = format!("{base}-{n}");
        n += 1;
    }
    let inst = instance_root.join(&id);
    game::install_deps(&app, &c, &dir, &version_id, &v, &inst).await?;
    game::prepare_instance(&inst)?;

    let background = instances::save_background(&inst, &req.background).map_err(|e| anyhow!(e))?;
    list.push(Instance {
        id,
        name,
        loader: req.loader,
        mc: req.mc,
        version_id,
        icon: req.icon,
        description: req.description,
        background,
    });
    instances::save(&cfg, &list).map_err(|e| anyhow!(e))?;
    emit(&app, "Instance ready");
    Ok(list)
}

#[derive(Deserialize)]
struct EditReq {
    id: String,
    name: String,
    icon: String, // empty = default logo for the loader
    description: String,
    background: String, // empty = no custom background
}

#[tauri::command]
fn edit_instance(req: EditReq) -> Result<Vec<Instance>, String> {
    let (_, _, cfg) = setup_dirs();
    let instance_root = instance_root()?;
    let mut list = instances::load(&cfg);
    let name = req.name.trim();
    if name.is_empty() {
        return Err("The name can't be empty".into());
    }
    let instance_id = list
        .iter()
        .find(|i| i.id == req.id)
        .map(|i| i.id.clone())
        .ok_or("Instance not found")?;
    let background = instances::save_background(&instance_root.join(instance_id), &req.background)?;
    let i = list
        .iter_mut()
        .find(|i| i.id == req.id)
        .ok_or("Instance not found")?;
    i.name = name.to_string();
    i.icon = req.icon;
    i.description = req.description;
    i.background = background;
    instances::save(&cfg, &list)?;
    Ok(list)
}

#[derive(Deserialize)]
struct RemoveReq {
    id: String,
    delete_files: bool,
}

#[tauri::command]
fn remove_instance(req: RemoveReq) -> Result<Vec<Instance>, String> {
    let (_, _, cfg) = setup_dirs();
    let mut list = instances::load(&cfg);
    if req.delete_files && list.iter().any(|i| i.id == req.id) {
        let path = instance_root()?.join(&req.id);
        match std::fs::remove_dir_all(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Could not delete instance files: {error}")),
        }
    }
    list.retain(|i| i.id != req.id);
    instances::save(&cfg, &list)?;
    Ok(list)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            mc_versions,
            system_ram,
            play,
            list_instances,
            load_instance_background,
            loader_support,
            create_instance,
            edit_instance,
            remove_instance,
            list_accounts,
            add_account,
            remove_account,
            select_account,
            get_skin,
            mods::mod_search,
            mods::mod_versions,
            mods::mod_install,
            mods::content_install,
            mods::modpack_install,
            list_content,
            toggle_content,
            delete_content,
            open_instance_folder,
            load_settings,
            save_settings,
            list_themes,
            load_theme,
            set_instance_directory,
            download_java_runtime
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod theme_tests {
    use super::{builtin_theme, theme_metadata, validate_theme_css};

    #[test]
    fn reads_custom_theme_name_and_author() {
        assert_eq!(
            theme_metadata("/*\nName: Forest\nAuthor: Example\n*/\n:root {}", "forest"),
            ("Forest".to_string(), "Example".to_string())
        );
    }

    #[test]
    fn allows_local_css_theme_rules() {
        assert!(validate_theme_css(":root { --bg: #101116; }").is_ok());
    }

    #[test]
    fn builtin_themes_pass_custom_css_safety_checks() {
        for id in ["builtin:default", "builtin:minimal", "builtin:minecraft"] {
            let theme = builtin_theme(id).expect("theme should be embedded");
            assert!(
                validate_theme_css(&theme.css).is_ok(),
                "{} should pass CSS validation",
                theme.name
            );
        }
    }

    #[test]
    fn rejects_external_css_resources_even_when_comments_split_the_token() {
        assert!(validate_theme_css("a { background: u/**/rl(https://example.com/x); }").is_err());
        assert!(validate_theme_css("@im/**/port 'https://example.com/theme.css';").is_err());
    }
}
