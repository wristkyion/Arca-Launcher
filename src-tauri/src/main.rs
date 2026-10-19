#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod accounts;
mod auth;
mod content;
mod game;
mod instances;
mod migration;
mod mods;

use accounts::{Store, Stored};
use anyhow::anyhow;
use base64::Engine;
use instances::Instance;
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    future::Future,
    io::Cursor,
    path::{Path, PathBuf},
    process::Command,
    sync::OnceLock,
};
use tauri::{AppHandle, Emitter, Manager};

pub fn emit(app: &AppHandle, msg: impl Into<String>) {
    let message = msg.into();
    let _ = app.emit("progress", message.clone());
    let _ = INSTALL_TASK_ID.try_with(|task_id| {
        let _ = app.emit(
            "install-progress",
            serde_json::json!({ "taskId": task_id, "message": message }),
        );
    });
}

tokio::task_local! {
    static INSTALL_TASK_ID: String;
}

pub async fn with_install_task<F: Future>(task_id: String, future: F) -> F::Output {
    if task_id.trim().is_empty() {
        future.await
    } else {
        INSTALL_TASK_ID.scope(task_id, future).await
    }
}

pub fn emit_game_log(app: &AppHandle, msg: impl Into<String>) {
    let _ = app.emit("game-log", msg.into());
}

const MICROSOFT_CLIENT_ID: Option<&str> = option_env!("ARCA_MICROSOFT_CLIENT_ID");

fn microsoft_client_id() -> anyhow::Result<&'static str> {
    MICROSOFT_CLIENT_ID
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| anyhow!("Microsoft sign-in is not configured for this launcher build."))
}

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
        author: "Built-in".to_string(),
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

fn contains_css_property(css: &str, property: &str) -> bool {
    css.split(['{', ';']).any(|declaration| {
        declaration
            .split_once(':')
            .is_some_and(|(name, _)| name.trim().eq_ignore_ascii_case(property))
    })
}

fn validate_theme_css(css: &str) -> Result<(), String> {
    let css = strip_css_comments(css);
    if css.contains('\\') {
        return Err("CSS escape sequences are not supported in custom themes".to_string());
    }
    let lower = css.to_ascii_lowercase();
    for blocked in ["expression(", "javascript:", "-moz-binding"] {
        if lower.contains(blocked) {
            return Err(format!("Theme CSS may not contain {blocked}"));
        }
    }
    if contains_css_property(&lower, "behavior") {
        return Err("Theme CSS may not use the legacy behavior property".to_string());
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
        author: "Built-in".to_string(),
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
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(windows)]
fn merge_target_metadata(path: &Path) -> std::io::Result<Option<std::fs::Metadata>> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("Refusing to follow symbolic link {}", path.display()),
        )),
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

#[cfg(windows)]
fn merge_directory(source: &Path, destination: &Path) -> std::io::Result<()> {
    if let Some(metadata) = merge_target_metadata(destination)? {
        if !metadata.is_dir() {
            std::fs::remove_file(destination)?;
        }
    }
    std::fs::create_dir_all(destination)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let target = destination.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            if let Some(metadata) = merge_target_metadata(&target)? {
                if !metadata.is_dir() {
                    std::fs::remove_file(&target)?;
                }
            }
            merge_directory(&entry.path(), &target)?;
        } else if file_type.is_file() {
            if let Some(metadata) = merge_target_metadata(&target)? {
                if metadata.is_dir() {
                    std::fs::remove_dir_all(&target)?;
                }
            }
            std::fs::copy(entry.path(), target)?;
        } else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("Unsupported file type in {}", entry.path().display()),
            ));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn move_legacy_data(legacy_root: &Path, root: &Path) -> std::io::Result<()> {
    if !legacy_root.is_dir() {
        return Ok(());
    }
    if let (Ok(current), Ok(legacy)) = (root.canonicalize(), legacy_root.canonicalize()) {
        if current == legacy {
            return Ok(());
        }
    }

    let folders = ["game", "jre", "launcher"];
    let existing_sources = folders
        .iter()
        .filter(|folder| legacy_root.join(folder).is_dir())
        .copied()
        .collect::<Vec<_>>();
    if existing_sources.is_empty() {
        return Ok(());
    }

    std::fs::create_dir_all(root)?;
    for folder in &existing_sources {
        merge_directory(&legacy_root.join(folder), &root.join(folder))?;
    }

    for folder in existing_sources {
        std::fs::remove_dir_all(legacy_root.join(folder))?;
    }
    if std::fs::read_dir(&legacy_root)?.next().is_none() {
        std::fs::remove_dir(&legacy_root)?;
    }
    Ok(())
}

#[cfg(windows)]
fn migrate_program_data(root: &Path) -> std::io::Result<()> {
    let Ok(program_data) = std::env::var("ProgramData") else {
        return Ok(());
    };
    move_legacy_data(&PathBuf::from(program_data).join("Arca Launcher"), root)
}

#[cfg(windows)]
static PROGRAM_DATA_MIGRATION: OnceLock<()> = OnceLock::new();

/// Returns (game dir, launcher dir, config dir) and creates the folder layout.
fn setup_dirs() -> (PathBuf, PathBuf, PathBuf) {
    let root = root_dir();
    #[cfg(windows)]
    PROGRAM_DATA_MIGRATION.get_or_init(|| {
        if let Err(error) = migrate_program_data(&root) {
            eprintln!("Could not move launcher data from ProgramData: {error}");
        }
    });
    let game = root.join("game");
    let launcher = root.join("launcher");
    let config = launcher.join("config");
    for d in [&game, &config, &root.join("jre").join("javaruntime")] {
        if let Err(error) = std::fs::create_dir_all(d) {
            eprintln!("Could not create {}: {error}", d.display());
        }
    }
    (game, launcher, config)
}

#[derive(Serialize, Deserialize)]
struct WindowSize {
    width: u32,
    height: u32,
}

fn window_size_path() -> PathBuf {
    setup_dirs().2.join("window-size.json")
}

fn restore_window_size(window: &tauri::WebviewWindow) -> Result<(), String> {
    let path = window_size_path();
    let size = match std::fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str::<WindowSize>(&contents)
            .map_err(|error| format!("Could not parse saved window size: {error}"))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => WindowSize {
            width: 920,
            height: 590,
        },
        Err(error) => return Err(format!("Could not read saved window size: {error}")),
    };
    if size.width < 640 || size.height < 400 {
        return Err("Saved window size is smaller than the supported minimum".into());
    }
    window
        .set_size(tauri::LogicalSize::new(
            size.width as f64,
            size.height as f64,
        ))
        .map_err(|error| format!("Could not restore saved window size: {error}"))
}

fn save_window_size(window: &tauri::Window) -> Result<(), String> {
    if window
        .is_maximized()
        .map_err(|error| format!("Could not determine window maximized state: {error}"))?
        || window
            .is_fullscreen()
            .map_err(|error| format!("Could not determine window fullscreen state: {error}"))?
    {
        return Ok(());
    }

    let scale_factor = window
        .scale_factor()
        .map_err(|error| format!("Could not read window scale factor: {error}"))?;
    let physical_size = window
        .inner_size()
        .map_err(|error| format!("Could not read window size: {error}"))?;
    let logical_size = physical_size.to_logical::<f64>(scale_factor);
    let size = WindowSize {
        width: logical_size.width.round() as u32,
        height: logical_size.height.round() as u32,
    };
    if size.width < 640 || size.height < 400 {
        return Ok(());
    }
    let path = window_size_path();
    let contents = serde_json::to_string(&size)
        .map_err(|error| format!("Could not serialize window size: {error}"))?;
    std::fs::write(path, contents).map_err(|error| format!("Could not save window size: {error}"))
}

#[tauri::command]
fn finish_startup(app: AppHandle) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window is not available".to_string())?;
    restore_window_size(&main)?;
    main.maximize()
        .map_err(|error| format!("Could not maximize main window: {error}"))?;
    main.show()
        .map_err(|error| format!("Could not show main window: {error}"))?;
    main.set_focus()
        .map_err(|error| format!("Could not focus main window: {error}"))?;
    if let Some(splash) = app.get_webview_window("splash") {
        let _ = splash.close();
    }
    Ok(())
}

#[tauri::command]
fn load_settings() -> Result<Value, String> {
    let (_, _, cfg) = setup_dirs();
    let settings_path = cfg.join("settings.json");
    let mut settings = match std::fs::read_to_string(&settings_path) {
        Ok(data) => {
            serde_json::from_str(&data).map_err(|e| format!("Could not parse settings: {e}"))?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(error) => return Err(format!("Could not read settings: {error}")),
    };
    let settings_object = settings
        .as_object_mut()
        .ok_or_else(|| "Settings must be a JSON object".to_string())?;
    let legacy_ms_client_id = settings_object
        .get("msClientId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_owned);
    if let Some(client_id) = legacy_ms_client_id {
        let mut store = accounts::load(&cfg);
        let mut migrated = false;
        for account in &mut store.accounts {
            if account.kind == "microsoft" && account.ms_client_id.is_none() {
                account.ms_client_id = Some(client_id.clone());
                migrated = true;
            }
        }
        if migrated {
            let serialized = serde_json::to_string_pretty(&store).map_err(|error| {
                format!("Could not migrate Microsoft account settings: {error}")
            })?;
            std::fs::write(cfg.join("accounts.json"), serialized).map_err(|error| {
                format!("Could not migrate Microsoft account settings: {error}")
            })?;
        }
    }
    let removed_microsoft_client_id = settings_object.remove("msClientId").is_some();
    let removed_curseforge_key = settings_object.remove("cfKey").is_some();
    let removed_legacy_credentials = removed_microsoft_client_id || removed_curseforge_key;
    let instance_directory = instance_root()?;
    settings_object
        .entry("settings")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| "Settings preferences must be a JSON object".to_string())?
        .insert(
            "instanceDirectory".into(),
            serde_json::Value::String(instance_directory.to_string_lossy().into_owned()),
        );
    if removed_legacy_credentials {
        let serialized = serde_json::to_string_pretty(&settings)
            .map_err(|error| format!("Could not migrate settings: {error}"))?;
        std::fs::write(settings_path, serialized)
            .map_err(|error| format!("Could not remove saved integration credentials: {error}"))?;
    }
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
    let version = version
        .strip_prefix('a')
        .or_else(|| version.strip_prefix('b'))
        .filter(|version| version.chars().next().is_some_and(|ch| ch.is_ascii_digit()))
        .unwrap_or(version);
    if version.starts_with("rd-") {
        return 8;
    }
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

fn requires_java_8_for_legacy_launchwrapper(version: &str) -> bool {
    if version.starts_with("rd-") {
        return true;
    }
    let version = version
        .strip_prefix('a')
        .or_else(|| version.strip_prefix('b'))
        .filter(|version| version.chars().next().is_some_and(|ch| ch.is_ascii_digit()))
        .unwrap_or(version);
    let mut parts = version
        .split('.')
        .filter_map(|part| part.parse::<u16>().ok());
    matches!((parts.next(), parts.next()), (Some(1), Some(minor)) if minor <= 12)
}

fn parse_java_major(text: &str) -> anyhow::Result<u8> {
    let version = text
        .split('"')
        .nth(1)
        .ok_or_else(|| anyhow!("Java did not report a recognizable version"))?;
    let mut parts = version.split('.');
    let first = parts
        .next()
        .and_then(|part| part.parse::<u8>().ok())
        .ok_or_else(|| anyhow!("Java did not report a recognizable version"))?;
    if first == 1 {
        parts
            .next()
            .and_then(|part| part.parse::<u8>().ok())
            .ok_or_else(|| anyhow!("Java did not report a recognizable version"))
    } else {
        Ok(first)
    }
}

fn detect_java_major(java: &str) -> anyhow::Result<u8> {
    let mut command = Command::new(java);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = command.arg("-version").output()?;
    if !output.status.success() {
        anyhow::bail!("Java version check exited with {}", output.status);
    }
    parse_java_major(&format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    ))
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
        if requires_java_8_for_legacy_launchwrapper(mc_version) {
            let major = detect_java_major(user).map_err(|error| {
                anyhow!("Could not check the selected Java runtime ({user}): {error}")
            })?;
            if major > 8 {
                anyhow::bail!(
                    "Minecraft {mc_version} uses an old LaunchWrapper that requires Java 8. The selected Java is {major}; set Custom Java path to a Java 8 runtime or clear that field to use the compatible launcher runtime."
                );
            }
        }
        return Ok(user.to_string());
    }
    match runtime_mode {
        "system" if requires_java_8_for_legacy_launchwrapper(mc_version) => {
            match detect_java_major("java") {
                Ok(major) if major <= 8 => return Ok("java".into()),
                Ok(major) => emit(
                    app,
                    format!(
                        "Minecraft {mc_version} needs Java 8; using a launcher-managed runtime instead of system Java {major}."
                    ),
                ),
                Err(error) => emit(
                    app,
                    format!(
                        "Could not use system Java for Minecraft {mc_version} ({error}); downloading a compatible Java 8 runtime."
                    ),
                ),
            }
            Ok(ensure_launcher_java(app, mc_version)
                .await?
                .to_string_lossy()
                .into_owned())
        }
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
    let dir = instance_root()?.join(id);
    if instances::read_one(&dir)?.is_none() {
        return Err("Instance not found".into());
    }
    Ok(dir)
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

#[tauri::command]
fn open_launcher_releases() -> Result<(), String> {
    webbrowser::open("https://github.com/wristkyion/Arca-Launcher/releases")
        .map(|_| ())
        .map_err(|error| format!("Could not open launcher releases: {error}"))
}

#[derive(Serialize)]
struct LauncherUpdateCheck {
    current_version: String,
    latest_version: String,
    update_available: bool,
}

fn version_is_newer(candidate: &str, current: &str) -> bool {
    fn components(version: &str) -> Option<Vec<u64>> {
        let version = version
            .strip_prefix('v')
            .or_else(|| version.strip_prefix('V'))
            .unwrap_or(version)
            .split(|character| character == '-' || character == '+')
            .next()?;
        let parts: Vec<u64> = version
            .split('.')
            .map(str::parse)
            .collect::<Result<_, _>>()
            .ok()?;
        (!parts.is_empty()).then_some(parts)
    }

    let (Some(candidate), Some(current)) = (components(candidate), components(current)) else {
        return false;
    };
    let width = candidate.len().max(current.len());
    (0..width)
        .map(|index| {
            (
                candidate.get(index).copied().unwrap_or(0),
                current.get(index).copied().unwrap_or(0),
            )
        })
        .find_map(|(candidate, current)| (candidate != current).then_some(candidate > current))
        .unwrap_or(false)
}

#[tauri::command]
async fn check_launcher_update() -> Result<LauncherUpdateCheck, String> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let response = game::http()
        .get("https://api.github.com/repos/wristkyion/Arca-Launcher/releases/latest")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| format!("Could not check GitHub releases: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Could not check GitHub releases: {error}"))?;
    let release: Value = response
        .json()
        .await
        .map_err(|error| format!("Could not read latest GitHub release: {error}"))?;
    let latest_version = release["tag_name"]
        .as_str()
        .ok_or_else(|| "Latest GitHub release has no version tag".to_string())?
        .to_string();

    Ok(LauncherUpdateCheck {
        update_available: version_is_newer(&latest_version, &current_version),
        current_version,
        latest_version,
    })
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
            let client_id = microsoft_client_id()?;
            let (a, rt) = auth::ms_new(&app, client_id).await?;
            Stored {
                id: new_id(),
                kind: "microsoft".into(),
                username: a.username,
                uuid: a.uuid,
                refresh_token: rt,
                ms_client_id: Some(client_id.to_string()),
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
    let instance_root = instance_root().map_err(|error| anyhow!(error))?;
    let inst_dir = instance_root.join(&req.instance);
    let rec = instances::read_one(&inst_dir)
        .map_err(|error| anyhow!(error))?
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
            let saved_client_id = saved
                .ms_client_id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_owned);
            let client_id = match saved_client_id {
                Some(id) => id,
                None => microsoft_client_id()?.to_owned(),
            };
            let (a, rt) = auth::ms_resume(&client_id, &saved.refresh_token).await?;
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
    let inst = inst_dir;
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
    let root = instance_root()?;
    let mut list = instances::scan_all(&root);
    for instance in &mut list {
        if instance.background.starts_with("data:image/") {
            let path = root.join(&instance.id);
            instance.background = instances::save_background(&path, &instance.background)?;
            instances::write_one(&path, instance)?;
        }
    }
    Ok(list)
}

#[tauri::command]
fn load_instance_background(id: String) -> Result<Option<String>, String> {
    let root = instance_root()?;
    let path = root.join(&id);
    let instance = instances::read_one(&path)?.ok_or_else(|| "Instance not found".to_string())?;
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
    #[serde(default)]
    task_id: String,
}

#[tauri::command]
async fn create_instance(app: AppHandle, req: CreateReq) -> Result<Vec<Instance>, String> {
    let task_id = req.task_id.clone();
    with_install_task(task_id, create(app, req))
        .await
        .map_err(|e| format!("{e:#}"))
}

async fn create(app: AppHandle, req: CreateReq) -> anyhow::Result<Vec<Instance>> {
    let name = req.name.trim().to_string();
    if name.is_empty() {
        anyhow::bail!("Give the instance a name");
    }
    let (dir, _, _cfg) = setup_dirs();
    let instance_root = instance_root().map_err(|error| anyhow!(error))?;
    let c = game::http();
    let java = pick_java(&app, &req.java, &req.java_mode, &req.mc).await?;

    emit(&app, "Creating instance...");
    game::install_vanilla(&app, &c, &dir, &req.mc).await?;
    let version_id = game::install_loader(&app, &c, &dir, &req.loader, &req.mc, &java).await?;
    let v = game::resolve(&dir, &version_id)?;

    let base = slug(&name);
    let mut id = base.clone();
    let mut n = 2;
    while instance_root.join(&id).exists() {
        id = format!("{base}-{n}");
        n += 1;
    }
    let inst_dir = instance_root.join(&id);
    game::install_deps(&app, &c, &dir, &version_id, &v, &inst_dir).await?;
    game::prepare_instance(&inst_dir)?;

    let background =
        instances::save_background(&inst_dir, &req.background).map_err(|e| anyhow!(e))?;
    let instance = Instance {
        id: id.clone(),
        name,
        loader: req.loader,
        mc: req.mc,
        version_id,
        icon: req.icon,
        description: req.description,
        background,
    };
    instances::write_one(&inst_dir, &instance).map_err(|e| anyhow!(e))?;
    emit(&app, "Instance ready");

    let mut list = instances::scan_all(&instance_root);
    list.retain(|i| i.id != id);
    list.push(instance);
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
    let root = instance_root()?;
    let dir = root.join(&req.id);
    let mut instance = instances::read_one(&dir)?.ok_or("Instance not found")?;
    let name = req.name.trim();
    if name.is_empty() {
        return Err("The name can't be empty".into());
    }
    let background = instances::save_background(&dir, &req.background)?;
    instance.name = name.to_string();
    instance.icon = req.icon;
    instance.description = req.description;
    instance.background = background;
    instances::write_one(&dir, &instance)?;
    Ok(instances::scan_all(&root))
}

#[derive(Deserialize)]
struct RemoveReq {
    id: String,
    delete_files: bool,
}

#[tauri::command]
fn remove_instance(req: RemoveReq) -> Result<Vec<Instance>, String> {
    let root = instance_root()?;
    let dir = root.join(&req.id);
    if req.delete_files {
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Could not delete instance files: {error}")),
        }
    } else {
        instances::forget_one(&dir)?;
    }
    Ok(instances::scan_all(&root))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let main = app
                .get_webview_window("main")
                .ok_or("Main window is not available during startup")?;
            if let Err(error) = restore_window_size(&main) {
                eprintln!("{error}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if window.label() == "splash" {
                    let main_visible = window
                        .app_handle()
                        .get_webview_window("main")
                        .and_then(|main| main.is_visible().ok())
                        .unwrap_or(false);
                    if !main_visible {
                        window.app_handle().exit(0);
                    }
                } else if let Err(error) = save_window_size(window) {
                    eprintln!("{error}");
                }
            }
        })
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
            mods::cancel_mod_install,
            mods::content_install,
            mods::modpack_install,
            list_content,
            toggle_content,
            delete_content,
            open_instance_folder,
            open_launcher_releases,
            check_launcher_update,
            finish_startup,
            load_settings,
            save_settings,
            list_themes,
            load_theme,
            set_instance_directory,
            download_java_runtime,
            migration::legacy_migration_pending,
            migration::migrate_legacy_instances
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
            assert_eq!(theme.author, "Built-in");
            assert!(
                validate_theme_css(&theme.css).is_ok(),
                "{} should pass CSS validation",
                theme.name
            );
        }
    }

    #[test]
    fn allows_external_css_resources_and_large_theme_files() {
        assert!(validate_theme_css("@import url('https://example.com/theme.css');").is_ok());
        assert!(
            validate_theme_css("a { background: url(https://example.com/image.png); }").is_ok()
        );
        let large_theme = format!("/*{}*/ :root {{ --bg: #101116; }}", "x".repeat(300 * 1024));
        assert!(validate_theme_css(&large_theme).is_ok());
    }

    #[test]
    fn still_rejects_script_like_css_constructs() {
        assert!(validate_theme_css("a { behavior: url(evil.htc); }").is_err());
        assert!(validate_theme_css("a { color: expression(alert(1)); }").is_err());
    }
}

#[cfg(test)]
mod launcher_update_tests {
    use super::version_is_newer;

    #[test]
    fn compares_release_versions_numerically() {
        assert!(version_is_newer("0.1.3", "0.1.2"));
        assert!(version_is_newer("v0.2.0", "0.1.9"));
        assert!(!version_is_newer("0.1.2", "0.1.2"));
        assert!(!version_is_newer("0.1.1", "0.1.2"));
        assert!(!version_is_newer("not-a-version", "0.1.2"));
    }
}

#[cfg(all(test, windows))]
mod data_migration_tests {
    use super::move_legacy_data;
    use std::path::PathBuf;

    fn test_paths() -> (PathBuf, PathBuf, PathBuf) {
        let temp = std::env::temp_dir().join(format!(
            "arca-launcher-migration-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let legacy = temp.join("ProgramData").join("Arca Launcher");
        let root = temp.join("Install");
        (temp, legacy, root)
    }

    #[test]
    fn moves_program_data_folders_beside_the_executable() {
        let (temp, legacy, root) = test_paths();
        let account_file = legacy.join("launcher").join("config").join("accounts.json");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(account_file.parent().unwrap()).unwrap();
        std::fs::write(&account_file, "{}").unwrap();
        std::fs::create_dir_all(legacy.join("game")).unwrap();
        std::fs::create_dir_all(legacy.join("jre")).unwrap();

        move_legacy_data(&legacy, &root).unwrap();

        assert_eq!(
            std::fs::read_to_string(root.join("launcher/config/accounts.json")).unwrap(),
            "{}"
        );
        assert!(root.join("game").is_dir());
        assert!(root.join("jre").is_dir());
        assert!(!legacy.exists());
        std::fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn program_data_replaces_matching_files_and_keeps_other_destination_files() {
        let (temp, legacy, root) = test_paths();
        let source_file = legacy.join("launcher").join("config").join("accounts.json");
        let destination_file = root.join("launcher").join("config").join("accounts.json");
        let destination_extra = root.join("launcher").join("themes").join("old.css");
        std::fs::create_dir_all(source_file.parent().unwrap()).unwrap();
        std::fs::create_dir_all(destination_file.parent().unwrap()).unwrap();
        std::fs::create_dir_all(destination_extra.parent().unwrap()).unwrap();
        std::fs::write(&source_file, "program data").unwrap();
        std::fs::write(&destination_file, "existing").unwrap();
        std::fs::write(&destination_extra, "keep").unwrap();

        move_legacy_data(&legacy, &root).unwrap();

        assert_eq!(
            std::fs::read_to_string(destination_file).unwrap(),
            "program data"
        );
        assert_eq!(std::fs::read_to_string(destination_extra).unwrap(), "keep");
        assert!(!legacy.exists());
        std::fs::remove_dir_all(temp).unwrap();
    }
}

#[cfg(test)]
mod java_runtime_tests {
    use super::{
        java_major_for_minecraft, parse_java_major, requires_java_8_for_legacy_launchwrapper,
    };

    #[test]
    fn detects_java_major_for_legacy_and_modern_version_strings() {
        assert_eq!(parse_java_major("java version \"1.8.0_452\"").unwrap(), 8);
        assert_eq!(parse_java_major("openjdk version \"17.0.15\"").unwrap(), 17);
        assert_eq!(parse_java_major("java version \"25.0.4\"").unwrap(), 25);
    }

    #[test]
    fn requires_java_8_for_legacy_launchwrapper_versions() {
        assert!(requires_java_8_for_legacy_launchwrapper("1.7.10"));
        assert!(requires_java_8_for_legacy_launchwrapper("1.12.2"));
        assert!(requires_java_8_for_legacy_launchwrapper("a1.2.2"));
        assert!(requires_java_8_for_legacy_launchwrapper("b1.7.3"));
        assert!(requires_java_8_for_legacy_launchwrapper("rd-132211"));
        assert!(!requires_java_8_for_legacy_launchwrapper("1.13"));
        assert_eq!(java_major_for_minecraft("1.7.10"), 8);
        assert_eq!(java_major_for_minecraft("a1.2.2"), 8);
        assert_eq!(java_major_for_minecraft("b1.7.3"), 8);
        assert_eq!(java_major_for_minecraft("rd-132211"), 8);
    }
}
