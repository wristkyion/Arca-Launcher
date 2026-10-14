#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod accounts;
mod auth;
mod game;
mod instances;
mod mods;
mod content;

use accounts::{Store, Stored};
use instances::Instance;
use anyhow::anyhow;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

pub fn emit(app: &AppHandle, msg: impl Into<String>) {
    let _ = app.emit("progress", msg.into());
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

/// Uses jre/javaruntime if it contains Java and the user left the field as "java".
fn pick_java(user: &str) -> String {
    let user = user.trim();
    if !user.is_empty() && user != "java" {
        return user.to_string();
    }
    let exe = if cfg!(windows) { "java.exe" } else { "java" };
    let p = root_dir().join("jre").join("javaruntime").join("bin").join(exe);
    if p.exists() { p.to_string_lossy().to_string() } else { "java".into() }
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
    let (dir, _, cfg) = setup_dirs();
    let inst = instances::load(&cfg).into_iter().find(|i| i.id == id).ok_or("Instance not found")?;
    Ok(dir.join("instances").join(&inst.id))
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
    content::toggle(&instance_dir(&req.instance)?, &req.kind, &req.file_name, req.enable).map_err(|e| format!("{e:#}"))
}

#[derive(Deserialize)]
struct DeleteContentReq {
    instance: String,
    kind: String,
    file_name: String,
}

#[tauri::command]
fn delete_content(req: DeleteContentReq) -> Result<(), String> {
    content::delete(&instance_dir(&req.instance)?, &req.kind, &req.file_name).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn open_instance_folder(req: ContentReq) -> Result<(), String> {
    let folder = content::folder_path(&instance_dir(&req.instance)?, &req.kind).map_err(|e| format!("{e:#}"))?;
    let _ = std::fs::create_dir_all(&folder);
    #[cfg(windows)]
    std::process::Command::new("explorer").arg(&folder).spawn().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").arg(&folder).spawn().map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open").arg(&folder).spawn().map_err(|e| e.to_string())?;
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
            .map(|a| AccountView { id: a.id.clone(), kind: a.kind.clone(), username: a.username.clone(), uuid: a.uuid.clone() })
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
            if n.len() < 3 || n.len() > 16 || !n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                anyhow::bail!("Username must be 3-16 characters: letters, numbers or _");
            }
            let a = auth::offline(n);
            Stored { id: new_id(), kind: "offline".into(), username: a.username, uuid: a.uuid, ..Default::default() }
        }
        // password login, then save the token
        "elyby" => {
            if req.username.trim().is_empty() || req.password.is_empty() {
                anyhow::bail!("Enter your Ely.by username and password");
            }
            let client_token = new_id();
            let a = auth::ely_login(&launcher_dir, req.username.trim(), &req.password, &client_token).await?;
            Stored { id: new_id(), kind: "elyby".into(), username: a.username, uuid: a.uuid, access_token: a.token, client_token, ..Default::default() }
        }
        // device-code login, then save the refresh token
        "microsoft" => {
            if req.ms_client_id.trim().is_empty() {
                anyhow::bail!("Enter your Azure client ID first (Settings tab)");
            }
            let (a, rt) = auth::ms_new(&app, req.ms_client_id.trim()).await?;
            Stored { id: new_id(), kind: "microsoft".into(), username: a.username, uuid: a.uuid, refresh_token: rt, ..Default::default() }
        }
        k => anyhow::bail!("Unknown account type {k}"),
    };

    // same account added twice -> update it instead of duplicating
    let pos = store.accounts.iter().position(|x| x.kind == stored.kind && x.uuid == stored.uuid);
    let id = match pos {
        Some(i) => {
            let id = store.accounts[i].id.clone();
            store.accounts[i] = Stored { id: id.clone(), ..stored };
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
            let r = c.get(format!("https://skinsystem.ely.by/textures/{username}")).send().await?;
            if !r.status().is_success() {
                return Ok(None);
            }
            r.json().await?
        }
        "microsoft" => {
            let r = c.get(format!("https://sessionserver.mojang.com/session/minecraft/profile/{uuid}")).send().await?;
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
    let Some(url) = skin["url"].as_str() else { return Ok(None) };
    let url = url.replacen("http://", "https://", 1);
    let png = c.get(&url).send().await?.error_for_status()?.bytes().await?;
    let data = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&png));
    Ok(Some(Skin { url, slim: skin["metadata"]["model"] == "slim", data }))
}

// ------------------------------------------------------------ playing

#[derive(Deserialize)]
struct PlayReq {
    instance: String,
    ram: u32,
    java: String,
    ms_client_id: String,
    jvm_args: String,
    game_args: String,
    hide: String,
    volume: Option<u32>,
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
    let java = pick_java(&req.java);

    // 0. The instance to launch
    let rec = instances::load(&cfg)
        .into_iter()
        .find(|i| i.id == req.instance)
        .ok_or_else(|| anyhow!("Select an instance first"))?;
    let id = rec.version_id.clone();
    if !dir.join("versions").join(&id).join(format!("{id}.json")).exists() {
        anyhow::bail!("The files for this instance are missing. Delete it and download it again.");
    }

    // 1. Use the selected saved account (refreshing its token if needed)
    emit(&app, "Logging in...");
    let mut store = accounts::load(&cfg);
    let sel = store.selected.clone().ok_or_else(|| anyhow!("Add an account first (Account tab)"))?;
    let idx = store.accounts.iter().position(|a| a.id == sel).ok_or_else(|| anyhow!("Selected account not found"))?;
    let saved = store.accounts[idx].clone();
    let account = match saved.kind.as_str() {
        "offline" => auth::offline(&saved.username),
        "elyby" => {
            let a = auth::ely_session(&launcher_dir, &saved.username, &saved.uuid, &saved.access_token, &saved.client_token).await?;
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
    let inst = dir.join("instances").join(&rec.id);
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
    if s.is_empty() { "instance".into() } else { s }
}

#[tauri::command]
fn list_instances() -> Vec<Instance> {
    let (_, _, cfg) = setup_dirs();
    instances::load(&cfg)
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
    let c = game::http();
    let java = pick_java(&req.java);

    emit(&app, "Creating instance...");
    game::install_vanilla(&app, &c, &dir, &req.mc).await?;
    let version_id = game::install_loader(&app, &c, &dir, &req.loader, &req.mc, &java).await?;
    let v = game::resolve(&dir, &version_id)?;

    let mut list = instances::load(&cfg);
    let base = slug(&name);
    let mut id = base.clone();
    let mut n = 2;
    while list.iter().any(|i| i.id == id) || dir.join("instances").join(&id).exists() {
        id = format!("{base}-{n}");
        n += 1;
    }
    let inst = dir.join("instances").join(&id);
    game::install_deps(&app, &c, &dir, &version_id, &v, &inst).await?;
    game::prepare_instance(&inst)?;

    list.push(Instance { id, name, loader: req.loader, mc: req.mc, version_id, icon: req.icon, description: req.description, background: req.background });
    instances::save(&cfg, &list);
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
    let mut list = instances::load(&cfg);
    let name = req.name.trim();
    if name.is_empty() {
        return Err("The name can't be empty".into());
    }
    let i = list.iter_mut().find(|i| i.id == req.id).ok_or("Instance not found")?;
    i.name = name.to_string();
    i.icon = req.icon;
    i.description = req.description;
    i.background = req.background;
    instances::save(&cfg, &list);
    Ok(list)
}

#[derive(Deserialize)]
struct RemoveReq {
    id: String,
    delete_files: bool,
}

#[tauri::command]
fn remove_instance(req: RemoveReq) -> Result<Vec<Instance>, String> {
    let (dir, _, cfg) = setup_dirs();
    let mut list = instances::load(&cfg);
    if req.delete_files && list.iter().any(|i| i.id == req.id) {
        let _ = std::fs::remove_dir_all(dir.join("instances").join(&req.id));
    }
    list.retain(|i| i.id != req.id);
    instances::save(&cfg, &list);
    Ok(list)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
        mc_versions, system_ram, play, list_instances, loader_support, create_instance, edit_instance, remove_instance,
        list_accounts, add_account, remove_account, select_account, get_skin,
        mods::mod_search, mods::mod_versions, mods::mod_install, mods::modpack_install,
        list_content, toggle_content, delete_content, open_instance_folder])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}