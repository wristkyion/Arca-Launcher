//! Minecraft content downloads from Modrinth and CurseForge.
use crate::{content, emit, game, instances, instances::Instance};
use anyhow::{anyhow, Result};
use futures::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
use tauri::AppHandle;

const MR: &str = "https://api.modrinth.com/v2";
const CF: &str = "https://api.curseforge.com/v1";

// ------------------------------------------------------------ helpers

fn curseforge_proxy_url(url: &str) -> Result<String> {
    let path = url
        .strip_prefix(CF)
        .ok_or_else(|| anyhow!("Invalid CurseForge API URL"))?;
    let base = option_env!("ARCA_CURSEFORGE_PROXY_URL")
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .ok_or_else(|| {
            anyhow!("CurseForge integration is not configured for this launcher build.")
        })?;
    map_curseforge_proxy_url(base, path)
}

fn map_curseforge_proxy_url(base: &str, path: &str) -> Result<String> {
    if !base.starts_with("https://")
        && !base.starts_with("http://127.0.0.1")
        && !base.starts_with("http://localhost")
    {
        return Err(anyhow!("The CurseForge proxy must use HTTPS."));
    }
    Ok(format!("{}{}", base.trim_end_matches('/'), path))
}

async fn jget(
    c: &reqwest::Client,
    url: &str,
    q: &[(&str, String)],
    _key: Option<&str>,
) -> Result<Value> {
    let proxy_url;
    let request_url = if url.starts_with(CF) {
        proxy_url = curseforge_proxy_url(url)?;
        proxy_url.as_str()
    } else {
        url
    };
    let resp = c.get(request_url).query(q).send().await?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await?;
        let detail = body.chars().take(300).collect::<String>();
        if url.starts_with(CF) && matches!(status.as_u16(), 401 | 403) {
            return Err(anyhow!(
                "CurseForge returned {status} for {request_url}: {detail}"
            ));
        }
        return Err(anyhow!(
            "Server answered {status} for {request_url}: {detail}"
        ));
    }
    Ok(resp.json().await?)
}

async fn cf_post_json(c: &reqwest::Client, url: &str, body: &Value) -> Result<reqwest::Response> {
    let request_url = curseforge_proxy_url(url)?;
    Ok(c.post(request_url).json(body).send().await?)
}

fn safe_name(n: &str) -> Result<String> {
    Path::new(n)
        .file_name()
        .and_then(|s| s.to_str())
        .map(String::from)
        .ok_or_else(|| anyhow!("Bad file name: {n}"))
}

fn safe_rel(s: &str) -> Result<PathBuf> {
    let p = Path::new(s);
    if !s.is_empty() && p.components().all(|c| matches!(c, Component::Normal(_))) {
        Ok(p.to_path_buf())
    } else {
        Err(anyhow!("Unsafe path inside the pack: {s}"))
    }
}

fn find_instance(id: &str) -> Result<(PathBuf, Instance)> {
    let (_, _, cfg) = crate::setup_dirs();
    let inst = instances::load(&cfg)
        .into_iter()
        .find(|i| i.id == id)
        .ok_or_else(|| anyhow!("Instance not found"))?;
    let instance_dir = crate::instance_root()
        .map_err(|error| anyhow!("{error}"))?
        .join(&inst.id);
    Ok((instance_dir, inst))
}

fn cf_loader(l: &str) -> Option<u32> {
    match l {
        "forge" => Some(1),
        "fabric" => Some(4),
        "quilt" => Some(5),
        "neoforge" => Some(6),
        _ => None,
    }
}

/// Newest release file (falls back to newest of any type).
fn cf_best(arr: &[Value]) -> &Value {
    let rel: Vec<&Value> = arr.iter().filter(|f| f["releaseType"] == 1).collect();
    let pool: Vec<&Value> = if rel.is_empty() {
        arr.iter().collect()
    } else {
        rel
    };
    pool.into_iter()
        .max_by(|a, b| a["fileDate"].as_str().cmp(&b["fileDate"].as_str()))
        .unwrap()
}

/// (download url, file name). Some mods hide downloadUrl; the CDN path still works for most.
fn cf_url(f: &Value) -> Option<(String, String)> {
    let name = f["fileName"].as_str()?;
    let url = match f["downloadUrl"].as_str() {
        Some(u) if !u.is_empty() => u.to_string(),
        _ => {
            let id = f["id"].as_u64()?;
            format!(
                "https://edge.forgecdn.net/files/{}/{}/{}",
                id / 1000,
                id % 1000,
                name
            )
        }
    };
    Some((url, name.to_string()))
}

/// CurseForge releaseType: 1 = release, 2 = beta, 3 = alpha.
fn cf_channel(release_type: i64) -> &'static str {
    match release_type {
        2 => "beta",
        3 => "alpha",
        _ => "release",
    }
}

async fn cf_project_details(c: &reqwest::Client, mod_id: &str) -> (String, String) {
    let project = jget(c, &format!("{CF}/mods/{mod_id}"), &[], None)
        .await
        .ok();
    (
        project
            .as_ref()
            .and_then(|v| v["data"]["name"].as_str())
            .unwrap_or(mod_id)
            .to_string(),
        project
            .as_ref()
            .and_then(|v| v["data"]["logo"]["thumbnailUrl"].as_str())
            .unwrap_or("")
            .to_string(),
    )
}

async fn mr_project_details(c: &reqwest::Client, pid: &str) -> (String, String) {
    let project = jget(c, &format!("{MR}/project/{pid}"), &[], None)
        .await
        .ok();
    (
        project
            .as_ref()
            .and_then(|v| v["title"].as_str())
            .unwrap_or(pid)
            .to_string(),
        project
            .as_ref()
            .and_then(|v| v["icon_url"].as_str())
            .unwrap_or("")
            .to_string(),
    )
}

// ------------------------------------------------------------ search

#[derive(Serialize)]
pub struct Hit {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub icon: String,
    pub downloads: u64,
    pub author: String,
    pub url: String,
}

#[derive(Serialize)]
pub struct SearchResult {
    pub hits: Vec<Hit>,
    pub total: u64,
}

#[derive(Deserialize)]
pub struct SearchReq {
    pub source: String, // modrinth | curseforge
    pub kind: String,   // mod | modpack | resourcepack | shader
    pub query: String,
    #[serde(default = "default_sort")]
    pub sort: String, // relevance | downloads | updated
    pub mc: String,     // "" = any
    pub loader: String, // "" = any
    pub offset: u32,
}

fn default_sort() -> String {
    "relevance".into()
}

#[tauri::command]
pub async fn mod_search(req: SearchReq) -> Result<SearchResult, String> {
    let c = game::http();
    if !matches!(
        req.kind.as_str(),
        "mod" | "modpack" | "resourcepack" | "shader"
    ) {
        return Err(format!("Unknown content kind {}", req.kind));
    }
    let r = match req.source.as_str() {
        "modrinth" => mr_search(&c, &req).await,
        "curseforge" => cf_search(&c, &req).await,
        s => Err(anyhow!("Unknown source {s}")),
    };
    r.map_err(|e| format!("{e:#}"))
}

async fn mr_search(c: &reqwest::Client, r: &SearchReq) -> Result<SearchResult> {
    let mut facets = vec![json!([format!("project_type:{}", r.kind)])];
    if !r.mc.is_empty() {
        facets.push(json!([format!("versions:{}", r.mc)]));
    }
    if !r.loader.is_empty() {
        facets.push(json!([format!("categories:{}", r.loader)]));
    }
    let index = match r.sort.as_str() {
        "downloads" => "downloads",
        "updated" => "updated",
        _ => "relevance",
    };
    let q = vec![
        ("query", r.query.clone()),
        ("facets", Value::Array(facets).to_string()),
        ("limit", "20".to_string()),
        ("offset", r.offset.to_string()),
        ("index", index.to_string()),
    ];
    let v = jget(c, &format!("{MR}/search"), &q, None).await?;
    let hits = v["hits"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|h| Hit {
            id: h["project_id"].as_str().unwrap_or("").into(),
            title: h["title"].as_str().unwrap_or("").into(),
            summary: h["description"].as_str().unwrap_or("").into(),
            icon: h["icon_url"].as_str().unwrap_or("").into(),
            downloads: h["downloads"].as_u64().unwrap_or(0),
            author: h["author"].as_str().unwrap_or("").into(),
            url: format!(
                "https://modrinth.com/{}/{}",
                h["project_type"].as_str().unwrap_or("mod"),
                h["slug"].as_str().unwrap_or("")
            ),
        })
        .collect();
    Ok(SearchResult {
        hits,
        total: v["total_hits"].as_u64().unwrap_or(0),
    })
}

async fn cf_search(c: &reqwest::Client, r: &SearchReq) -> Result<SearchResult> {
    let class = match r.kind.as_str() {
        "mod" => 6,
        "modpack" => 4471,
        "resourcepack" => 12,
        "shader" => 6552,
        other => return Err(anyhow!("Unknown content kind {other}")),
    };
    let mut q = vec![
        ("gameId", "432".to_string()),
        ("classId", class.to_string()),
        ("searchFilter", r.query.clone()),
        ("pageSize", "20".to_string()),
        ("index", r.offset.to_string()),
    ];
    match r.sort.as_str() {
        "downloads" => {
            q.push(("sortField", "6".to_string()));
            q.push(("sortOrder", "desc".to_string()));
        }
        "updated" => {
            q.push(("sortField", "3".to_string()));
            q.push(("sortOrder", "desc".to_string()));
        }
        _ => {}
    }
    if !r.mc.is_empty() {
        q.push(("gameVersion", r.mc.clone()));
    }
    if let Some(t) = cf_loader(&r.loader) {
        q.push(("modLoaderType", t.to_string()));
    }
    let v = jget(c, &format!("{CF}/mods/search"), &q, None).await?;
    let hits = v["data"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|h| Hit {
            id: h["id"].as_u64().unwrap_or(0).to_string(),
            title: h["name"].as_str().unwrap_or("").into(),
            summary: h["summary"].as_str().unwrap_or("").into(),
            icon: h["logo"]["thumbnailUrl"].as_str().unwrap_or("").into(),
            downloads: h["downloadCount"].as_f64().unwrap_or(0.0) as u64,
            author: h["authors"][0]["name"].as_str().unwrap_or("").into(),
            url: h["links"]["websiteUrl"].as_str().unwrap_or("").into(),
        })
        .collect();
    Ok(SearchResult {
        hits,
        total: v["pagination"]["totalCount"].as_u64().unwrap_or(0),
    })
}

// ------------------------------------------------------------ browsing a project's versions

#[derive(Serialize)]
pub struct VersionHit {
    pub id: String,      // Modrinth version id / CurseForge file id
    pub name: String,    // version number or display name
    pub channel: String, // "release" | "beta" | "alpha"
    pub game_versions: Vec<String>,
    pub date: String,
}

#[derive(Deserialize)]
pub struct VersionsReq {
    pub source: String,
    pub id: String, // project id / mod id
}

#[tauri::command]
pub async fn mod_versions(req: VersionsReq) -> Result<Vec<VersionHit>, String> {
    versions(req).await.map_err(|e| format!("{e:#}"))
}

async fn versions(req: VersionsReq) -> Result<Vec<VersionHit>> {
    let c = game::http();
    match req.source.as_str() {
        "modrinth" => {
            let list = jget(&c, &format!("{MR}/project/{}/version", req.id), &[], None).await?;
            Ok(list
                .as_array()
                .into_iter()
                .flatten()
                .map(|v| VersionHit {
                    id: v["id"].as_str().unwrap_or("").into(),
                    name: v["version_number"].as_str().unwrap_or("").into(),
                    channel: v["version_type"].as_str().unwrap_or("release").into(),
                    game_versions: v["game_versions"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect(),
                    date: v["date_published"].as_str().unwrap_or("").into(),
                })
                .collect())
        }
        "curseforge" => {
            let v = jget(
                &c,
                &format!("{CF}/mods/{}/files", req.id),
                &[("pageSize", "50".to_string())],
                None,
            )
            .await?;
            Ok(v["data"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|f| VersionHit {
                    id: f["id"].as_u64().unwrap_or(0).to_string(),
                    name: f["displayName"].as_str().unwrap_or("").into(),
                    channel: cf_channel(f["releaseType"].as_i64().unwrap_or(1)).into(),
                    game_versions: f["gameVersions"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect(),
                    date: f["fileDate"].as_str().unwrap_or("").into(),
                })
                .collect())
        }
        s => Err(anyhow!("Unknown source {s}")),
    }
}

// ------------------------------------------------------------ install a mod into an instance

#[derive(Deserialize)]
pub struct InstallReq {
    pub source: String,
    pub id: String,
    /// The display title of the mod being installed (already known by the frontend from the
    /// search results), so the root entry doesn't need an extra lookup just for its name.
    pub title: String,
    pub instance: String,
    /// A specific Modrinth version id / CurseForge file id to install for the root project.
    /// None = pick the newest version that fits the instance (the old behaviour). Dependencies
    /// are always resolved to their own newest compatible version, regardless of this.
    #[serde(default)]
    pub version_id: Option<String>,
    #[serde(default)]
    pub icon: String,
}

/// One installed content file, with its version/channel and whether it was pulled in as a dependency.
#[derive(Serialize, Clone)]
pub struct InstalledFile {
    pub project_id: String,
    pub project_name: String,
    pub file_name: String,
    pub version: String,
    /// "release" | "beta" | "alpha"
    pub channel: String,
    pub dependency: bool,
    pub source: String,
    pub icon: String,
}

#[tauri::command]
pub async fn mod_install(app: AppHandle, req: InstallReq) -> Result<Vec<InstalledFile>, String> {
    install(app, req).await.map_err(|e| format!("{e:#}"))
}

async fn install(app: AppHandle, req: InstallReq) -> Result<Vec<InstalledFile>> {
    let (instance_dir, inst) = find_instance(&req.instance)?;
    if inst.loader == "vanilla" {
        return Err(anyhow!(
            "Vanilla instances can't use mods. Create a Fabric, Quilt, Forge or NeoForge instance."
        ));
    }
    let mods = instance_dir.join("mods");
    fs::create_dir_all(&mods)?;
    let c = game::http();
    let source = req.source.clone();
    let mut files = match source.as_str() {
        "modrinth" => {
            mr_install(
                &app,
                &c,
                &mods,
                &inst,
                &req.id,
                &req.title,
                req.version_id.as_deref(),
            )
            .await
        }
        "curseforge" => {
            cf_install(
                &app,
                &c,
                &mods,
                &inst,
                &req.id,
                &req.title,
                req.version_id.as_deref(),
            )
            .await
        }
        s => Err(anyhow!("Unknown source {s}")),
    }?;
    for file in &mut files {
        file.source = source.clone();
        if !file.dependency {
            file.icon = req.icon.clone();
        }
    }
    content::record(
        &instance_dir,
        "mods",
        files.iter().map(|file| {
            (
                file.file_name.clone(),
                content::ContentMetadata {
                    project_id: file.project_id.clone(),
                    project_name: file.project_name.clone(),
                    source: file.source.clone(),
                    icon: file.icon.clone(),
                    version: file.version.clone(),
                    channel: file.channel.clone(),
                    dependency: file.dependency,
                },
            )
        }),
    )?;
    Ok(files)
}

#[derive(Deserialize)]
pub struct ContentInstallReq {
    pub source: String,
    pub kind: String, // resourcepack | shader
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub icon: String,
    pub instance: String,
    #[serde(default)]
    pub version_id: Option<String>,
}

#[tauri::command]
pub async fn content_install(
    app: AppHandle,
    req: ContentInstallReq,
) -> Result<Vec<InstalledFile>, String> {
    install_content(app, req)
        .await
        .map_err(|e| format!("{e:#}"))
}

async fn install_content(app: AppHandle, req: ContentInstallReq) -> Result<Vec<InstalledFile>> {
    let folder = match req.kind.as_str() {
        "resourcepack" => "resourcepacks",
        "shader" => "shaderpacks",
        other => return Err(anyhow!("Unsupported install content kind {other}")),
    };
    let (instance_dir, inst) = find_instance(&req.instance)?;
    let target = instance_dir.join(folder);
    fs::create_dir_all(&target)?;
    let c = game::http();

    let (url, file_name, version, channel) = match req.source.as_str() {
        "modrinth" => {
            let ver: Value = match req.version_id.as_deref() {
                Some(id) => jget(&c, &format!("{MR}/version/{id}"), &[], None).await?,
                None => {
                    let q = vec![("game_versions", json!([inst.mc]).to_string())];
                    let versions =
                        jget(&c, &format!("{MR}/project/{}/version", req.id), &q, None).await?;
                    let list = versions
                        .as_array()
                        .filter(|items| !items.is_empty())
                        .ok_or_else(|| {
                            anyhow!("No version is available for Minecraft {}", inst.mc)
                        })?;
                    list.iter()
                        .find(|v| v["version_type"] == "release")
                        .unwrap_or(&list[0])
                        .clone()
                }
            };
            if ver["project_id"].as_str() != Some(req.id.as_str()) {
                return Err(anyhow!(
                    "The selected version does not belong to this project"
                ));
            }
            let file = ver["files"]
                .as_array()
                .and_then(|files| {
                    files
                        .iter()
                        .find(|f| f["primary"] == true)
                        .or(files.first())
                })
                .ok_or_else(|| anyhow!("This version has no files"))?;
            (
                file["url"]
                    .as_str()
                    .ok_or_else(|| anyhow!("File has no download link"))?
                    .to_string(),
                safe_name(file["filename"].as_str().unwrap_or("content.zip"))?,
                ver["version_number"].as_str().unwrap_or("").to_string(),
                ver["version_type"]
                    .as_str()
                    .unwrap_or("release")
                    .to_string(),
            )
        }
        "curseforge" => {
            let file = if let Some(id) = req.version_id.as_deref() {
                let response =
                    jget(&c, &format!("{CF}/mods/{}/files/{id}", req.id), &[], None).await?;
                response["data"].clone()
            } else {
                let q = vec![
                    ("pageSize", "50".to_string()),
                    ("gameVersion", inst.mc.clone()),
                ];
                let response = jget(&c, &format!("{CF}/mods/{}/files", req.id), &q, None).await?;
                let files = response["data"]
                    .as_array()
                    .filter(|items| !items.is_empty())
                    .ok_or_else(|| anyhow!("No version is available for Minecraft {}", inst.mc))?;
                cf_best(files).clone()
            };
            let (url, name) =
                cf_url(&file).ok_or_else(|| anyhow!("This file has no download link"))?;
            (
                url,
                safe_name(&name)?,
                file["displayName"].as_str().unwrap_or("").to_string(),
                cf_channel(file["releaseType"].as_i64().unwrap_or(1)).to_string(),
            )
        }
        other => return Err(anyhow!("Unknown source {other}")),
    };

    if !Path::new(&file_name)
        .extension()
        .and_then(|ext| ext.to_str())
        .map_or(false, |ext| ext.eq_ignore_ascii_case("zip"))
    {
        return Err(anyhow!(
            "This content is not a .zip pack and cannot be installed here"
        ));
    }
    emit(&app, format!("Downloading {file_name}"));
    game::download(&c, &url, &target.join(&file_name)).await?;
    content::record(
        &instance_dir,
        folder,
        [(
            file_name.clone(),
            content::ContentMetadata {
                project_id: req.id.clone(),
                project_name: req.title.clone(),
                source: req.source.clone(),
                icon: req.icon.clone(),
                version: version.clone(),
                channel: channel.clone(),
                dependency: false,
            },
        )],
    )?;

    Ok(vec![InstalledFile {
        project_id: req.id,
        project_name: req.title,
        file_name,
        version,
        channel,
        dependency: false,
        source: req.source,
        icon: req.icon,
    }])
}

/// Picks the newest compatible version of a Modrinth project, downloads it and
/// returns (installed file info, required dependencies).
async fn mr_fetch_one(
    app: &AppHandle,
    c: &reqwest::Client,
    mods: &Path,
    inst: &Instance,
    project: &str,
    version_id: Option<&str>,
    known_title: Option<&str>,
    dependency: bool,
) -> Result<(InstalledFile, Vec<(String, Option<String>)>)> {
    let ver: Value = match version_id {
        Some(vid) => jget(c, &format!("{MR}/version/{vid}"), &[], None).await?,
        None => {
            let q = vec![
                ("loaders", json!([inst.loader]).to_string()),
                ("game_versions", json!([inst.mc]).to_string()),
            ];
            let list = jget(c, &format!("{MR}/project/{project}/version"), &q, None).await?;
            let arr = list
                .as_array()
                .filter(|a| !a.is_empty())
                .ok_or_else(|| anyhow!("No version for Minecraft {} + {}", inst.mc, inst.loader))?;
            arr.iter()
                .find(|v| v["version_type"] == "release")
                .unwrap_or(&arr[0])
                .clone()
        }
    };
    let file = ver["files"]
        .as_array()
        .and_then(|a| a.iter().find(|f| f["primary"] == true).or(a.first()))
        .ok_or_else(|| anyhow!("This version has no files"))?;
    let url = file["url"]
        .as_str()
        .ok_or_else(|| anyhow!("File has no download link"))?;
    let name = safe_name(file["filename"].as_str().unwrap_or("mod.jar"))?;
    emit(app, format!("Downloading {name}"));
    game::download(c, url, &mods.join(&name)).await?;

    let deps = ver["dependencies"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|d| d["dependency_type"] == "required")
        .filter_map(|d| {
            Some((
                d["project_id"].as_str()?.to_string(),
                d["version_id"].as_str().map(String::from),
            ))
        })
        .collect();

    let (project_name, icon) = match known_title {
        Some(t) if !t.trim().is_empty() => (t.to_string(), String::new()),
        _ => mr_project_details(c, project).await,
    };
    let info = InstalledFile {
        project_id: project.to_string(),
        project_name,
        file_name: name,
        version: ver["version_number"].as_str().unwrap_or("").to_string(),
        channel: ver["version_type"]
            .as_str()
            .unwrap_or("release")
            .to_string(),
        dependency,
        source: String::new(),
        icon,
    };
    Ok((info, deps))
}

async fn mr_install(
    app: &AppHandle,
    c: &reqwest::Client,
    mods: &Path,
    inst: &Instance,
    project: &str,
    title: &str,
    root_version: Option<&str>,
) -> Result<Vec<InstalledFile>> {
    // (project id, version id, is this a dependency, known title)
    let mut queue: Vec<(String, Option<String>, bool, Option<String>)> = vec![(
        project.to_string(),
        root_version.map(String::from),
        false,
        Some(title.to_string()),
    )];
    let mut seen = HashSet::new();
    let mut files = vec![];
    while let Some((pid, vid, dependency, known_title)) = queue.pop() {
        if !seen.insert(pid.clone()) {
            continue;
        }
        match mr_fetch_one(
            app,
            c,
            mods,
            inst,
            &pid,
            vid.as_deref(),
            known_title.as_deref(),
            dependency,
        )
        .await
        {
            Ok((info, deps)) => {
                files.push(info);
                queue.extend(deps.into_iter().map(|(id, vid)| (id, vid, true, None)));
            }
            Err(e) if pid == project => return Err(e),
            Err(e) => emit(app, format!("Skipped required dependency {pid}: {e:#}")),
        }
    }
    emit(app, format!("Installed {} file(s)", files.len()));
    Ok(files)
}

async fn cf_fetch_one(
    app: &AppHandle,
    c: &reqwest::Client,
    mods: &Path,
    inst: &Instance,
    mod_id: &str,
    known_title: Option<&str>,
    dependency: bool,
    target_file: Option<&str>,
) -> Result<(InstalledFile, Vec<String>)> {
    let fetched;
    let best = match target_file {
        // the person picked an exact file from the version list
        Some(fid) => {
            let v = jget(c, &format!("{CF}/mods/{mod_id}/files/{fid}"), &[], None).await?;
            fetched = v["data"].clone();
            &fetched
        }
        // no specific file asked for (always the case for dependencies): newest compatible one
        None => {
            let mut q = vec![
                ("pageSize", "50".to_string()),
                ("gameVersion", inst.mc.clone()),
            ];
            if let Some(t) = cf_loader(&inst.loader) {
                q.push(("modLoaderType", t.to_string()));
            }
            let v = jget(c, &format!("{CF}/mods/{mod_id}/files"), &q, None).await?;
            let arr = v["data"]
                .as_array()
                .cloned()
                .filter(|a| !a.is_empty())
                .ok_or_else(|| anyhow!("No file for Minecraft {} + {}", inst.mc, inst.loader))?;
            fetched = cf_best(&arr).clone();
            &fetched
        }
    };
    let (url, name) = cf_url(best).ok_or_else(|| anyhow!("This file has no download link"))?;
    let name = safe_name(&name)?;
    emit(app, format!("Downloading {name}"));
    game::download(c, &url, &mods.join(&name))
        .await
        .map_err(|e| anyhow!("{name} could not be downloaded ({e:#}). The author may only allow downloads from the CurseForge website."))?;

    let deps = best["dependencies"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|d| d["relationType"] == 3) // 3 = required dependency
        .filter_map(|d| d["modId"].as_u64().map(|x| x.to_string()))
        .collect();

    let (project_name, icon) = match known_title {
        Some(t) if !t.trim().is_empty() => (t.to_string(), String::new()),
        _ => cf_project_details(c, mod_id).await,
    };
    let info = InstalledFile {
        project_id: mod_id.to_string(),
        project_name,
        file_name: name,
        version: best["displayName"].as_str().unwrap_or("").to_string(),
        channel: cf_channel(best["releaseType"].as_i64().unwrap_or(1)).to_string(),
        dependency,
        source: String::new(),
        icon,
    };
    Ok((info, deps))
}

async fn cf_install(
    app: &AppHandle,
    c: &reqwest::Client,
    mods: &Path,
    inst: &Instance,
    project: &str,
    title: &str,
    root_version: Option<&str>,
) -> Result<Vec<InstalledFile>> {
    // (mod id, is this a dependency, known title)
    let mut queue: Vec<(String, bool, Option<String>)> =
        vec![(project.to_string(), false, Some(title.to_string()))];
    let mut seen = HashSet::new();
    let mut files = vec![];
    while let Some((id, dependency, known_title)) = queue.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        let target = if dependency { None } else { root_version };
        match cf_fetch_one(
            app,
            c,
            mods,
            inst,
            &id,
            known_title.as_deref(),
            dependency,
            target,
        )
        .await
        {
            Ok((info, deps)) => {
                files.push(info);
                queue.extend(deps.into_iter().map(|d| (d, true, None)));
            }
            Err(e) if id == project => return Err(e),
            Err(e) => emit(app, format!("Skipped required dependency {id}: {e:#}")),
        }
    }
    emit(app, format!("Installed {} file(s)", files.len()));
    Ok(files)
}

// ------------------------------------------------------------ modpacks

#[derive(Deserialize)]
pub struct PackReq {
    pub source: String,
    pub id: String,
    pub name: String,
    pub java: String,
    #[serde(default = "default_java_runtime")]
    pub java_mode: String,
}

fn default_java_runtime() -> String {
    "system".into()
}

#[tauri::command]
pub async fn modpack_install(app: AppHandle, req: PackReq) -> Result<Vec<Instance>, String> {
    pack(app, req).await.map_err(|e| format!("{e:#}"))
}

struct Plan {
    mc: String,
    loader: String,
    urls: Vec<(String, String)>, // (relative path, url)  Modrinth
    cf_files: Vec<u64>,          // CurseForge file ids
    overrides: Vec<String>,      // folders inside the zip that are copied into the instance
}

async fn mr_pack_file(c: &reqwest::Client, id: &str) -> Result<(String, String)> {
    let list = jget(c, &format!("{MR}/project/{id}/version"), &[], None).await?;
    let arr = list
        .as_array()
        .filter(|a| !a.is_empty())
        .ok_or_else(|| anyhow!("This modpack has no versions"))?;
    let v = arr
        .iter()
        .find(|v| v["version_type"] == "release")
        .unwrap_or(&arr[0]);
    let f = v["files"]
        .as_array()
        .and_then(|a| a.iter().find(|f| f["primary"] == true).or(a.first()))
        .ok_or_else(|| anyhow!("No file in the modpack version"))?;
    Ok((
        f["url"]
            .as_str()
            .ok_or_else(|| anyhow!("No download link"))?
            .to_string(),
        safe_name(f["filename"].as_str().unwrap_or("pack.mrpack"))?,
    ))
}

async fn cf_pack_file(c: &reqwest::Client, id: &str) -> Result<(String, String)> {
    let v = jget(
        c,
        &format!("{CF}/mods/{id}/files"),
        &[("pageSize", "20".to_string())],
        None,
    )
    .await?;
    let arr = v["data"]
        .as_array()
        .filter(|a| !a.is_empty())
        .ok_or_else(|| anyhow!("This modpack has no files"))?;
    let (url, name) =
        cf_url(cf_best(arr)).ok_or_else(|| anyhow!("The modpack has no download link"))?;
    Ok((url, safe_name(&name)?))
}

fn read_plan(source: &str, archive: &Path) -> Result<Plan> {
    let mut z = zip::ZipArchive::new(fs::File::open(archive)?)?;
    if source == "modrinth" {
        let mut s = String::new();
        z.by_name("modrinth.index.json")
            .map_err(|_| anyhow!("Not a valid .mrpack file (modrinth.index.json is missing)"))?
            .read_to_string(&mut s)?;
        let v: Value = serde_json::from_str(&s)?;
        let d = &v["dependencies"];
        let mc = d["minecraft"]
            .as_str()
            .ok_or_else(|| anyhow!("The pack doesn't say which Minecraft version it uses"))?
            .to_string();
        let loader = if d.get("fabric-loader").is_some() {
            "fabric"
        } else if d.get("quilt-loader").is_some() {
            "quilt"
        } else if d.get("neoforge").is_some() {
            "neoforge"
        } else if d.get("forge").is_some() {
            "forge"
        } else {
            "vanilla"
        };
        let urls = v["files"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|f| f["env"]["client"] != "unsupported")
            .filter_map(|f| {
                Some((
                    f["path"].as_str()?.to_string(),
                    f["downloads"][0].as_str()?.to_string(),
                ))
            })
            .collect();
        Ok(Plan {
            mc,
            loader: loader.into(),
            urls,
            cf_files: vec![],
            overrides: vec!["overrides/".into(), "client-overrides/".into()],
        })
    } else {
        let mut s = String::new();
        z.by_name("manifest.json")
            .map_err(|_| anyhow!("Not a valid CurseForge pack (manifest.json is missing)"))?
            .read_to_string(&mut s)?;
        let m: Value = serde_json::from_str(&s)?;
        let mc = m["minecraft"]["version"]
            .as_str()
            .ok_or_else(|| anyhow!("The pack doesn't say which Minecraft version it uses"))?
            .to_string();
        let loaders = m["minecraft"]["modLoaders"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let first = loaders
            .iter()
            .find(|l| l["primary"] == true)
            .or(loaders.first());
        let loader = first
            .and_then(|l| l["id"].as_str())
            .and_then(|id| id.split('-').next())
            .filter(|l| ["forge", "fabric", "quilt", "neoforge"].contains(l))
            .unwrap_or("vanilla")
            .to_string();
        let cf_files = m["files"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|f| f["fileID"].as_u64())
            .collect();
        let ov = m["overrides"].as_str().unwrap_or("overrides");
        Ok(Plan {
            mc,
            loader,
            urls: vec![],
            cf_files,
            overrides: vec![format!("{ov}/")],
        })
    }
}

fn extract_overrides(archive: &Path, prefixes: &[String], inst: &Path) -> Result<()> {
    let mut z = zip::ZipArchive::new(fs::File::open(archive)?)?;
    for i in 0..z.len() {
        let mut f = z.by_index(i)?;
        if f.is_dir() {
            continue;
        }
        let name = f.name().to_string();
        for p in prefixes {
            if let Some(rel) = name.strip_prefix(p.as_str()) {
                if let Ok(rel) = safe_rel(rel) {
                    let out = inst.join(rel);
                    if let Some(parent) = out.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    let mut o = fs::File::create(&out)?;
                    std::io::copy(&mut f, &mut o)?;
                }
                break;
            }
        }
    }
    Ok(())
}

async fn pack(app: AppHandle, req: PackReq) -> Result<Vec<Instance>> {
    let (dir, launcher, cfg) = crate::setup_dirs();
    let instance_root = crate::instance_root().map_err(|error| anyhow!("{error}"))?;
    let c = game::http();
    let name = req.name.trim().to_string();
    if name.is_empty() {
        return Err(anyhow!("The modpack has no name"));
    }

    emit(&app, "Creating instance...");

    // 1. download the pack archive
    let (url, fname) = match req.source.as_str() {
        "modrinth" => mr_pack_file(&c, &req.id).await?,
        "curseforge" => cf_pack_file(&c, &req.id).await?,
        s => return Err(anyhow!("Unknown source {s}")),
    };
    let cache = launcher.join("cache");
    fs::create_dir_all(&cache)?;
    let archive = cache.join(&fname);
    let _ = fs::remove_file(&archive);
    emit(&app, format!("Downloading {fname}"));
    game::download(&c, &url, &archive).await?;

    // 2. read what the pack needs
    let plan = read_plan(&req.source, &archive)?;
    let java = crate::pick_java(&app, &req.java, &req.java_mode, &plan.mc).await?;
    emit(
        &app,
        format!("Pack uses Minecraft {} with {}", plan.mc, plan.loader),
    );

    // 3. Minecraft + loader + libraries/assets
    game::install_vanilla(&app, &c, &dir, &plan.mc).await?;
    let version_id = game::install_loader(&app, &c, &dir, &plan.loader, &plan.mc, &java).await?;
    let v = game::resolve(&dir, &version_id)?;

    let mut list = instances::load(&cfg);
    let base = crate::slug(&name);
    let mut id = base.clone();
    let mut n = 2;
    while list.iter().any(|i| i.id == id) || instance_root.join(&id).exists() {
        id = format!("{base}-{n}");
        n += 1;
    }
    let inst = instance_root.join(&id);
    game::install_deps(&app, &c, &dir, &version_id, &v, &inst).await?;
    game::prepare_instance(&inst)?;

    // 4. the pack's own files (mods, ...)
    let mut jobs: Vec<(String, PathBuf)> = vec![];
    for (path, url) in &plan.urls {
        jobs.push((url.clone(), inst.join(safe_rel(path)?)));
    }
    if !plan.cf_files.is_empty() {
        for chunk in plan.cf_files.chunks(100) {
            let resp = cf_post_json(
                &c,
                &format!("{CF}/mods/files"),
                &json!({ "fileIds": chunk }),
            )
            .await?;
            if !resp.status().is_success() {
                return Err(anyhow!(
                    "CurseForge answered {} while listing the pack files",
                    resp.status()
                ));
            }
            let data: Value = resp.json().await?;
            for f in data["data"].as_array().into_iter().flatten() {
                if let Some((url, fname)) = cf_url(f) {
                    jobs.push((url, inst.join("mods").join(safe_name(&fname)?)));
                }
            }
        }
    }
    let total = jobs.len();
    emit(&app, format!("Downloading {total} pack files"));
    let done = Arc::new(AtomicUsize::new(0));
    let results: Vec<Result<()>> = stream::iter(jobs)
        .map(|(url, path)| {
            let c = c.clone();
            let done = done.clone();
            let app = app.clone();
            async move {
                let r = game::download_logged(&app, &c, &url, &path).await;
                let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                if n % 5 == 0 || n == total {
                    emit(&app, format!("Files {n}/{total}"));
                }
                r
            }
        })
        .buffer_unordered(8)
        .collect()
        .await;
    let failed: Vec<String> = results
        .iter()
        .filter_map(|r| r.as_ref().err().map(|e| format!("{e:#}")))
        .collect();
    if !failed.is_empty() {
        emit(
            &app,
            format!(
                "Warning: {} file(s) could not be downloaded (first error: {})",
                failed.len(),
                failed[0]
            ),
        );
    }

    // 5. config files, resource packs etc. shipped inside the pack
    extract_overrides(&archive, &plan.overrides, &inst)?;

    list.push(Instance {
        id,
        name,
        loader: plan.loader,
        mc: plan.mc,
        version_id,
        icon: String::new(),
        description: String::new(),
        background: String::new(),
    });
    instances::save(&cfg, &list).map_err(|e| anyhow!("{e}"))?;
    emit(&app, "Instance ready");
    Ok(list)
}

#[cfg(test)]
mod tests {
    use super::map_curseforge_proxy_url;

    #[test]
    fn curseforge_proxy_preserves_api_path_and_requires_https() {
        assert_eq!(
            map_curseforge_proxy_url("https://proxy.example/v1", "/mods/search").unwrap(),
            "https://proxy.example/v1/mods/search"
        );
        assert!(map_curseforge_proxy_url("http://proxy.example/v1", "/mods/search").is_err());
    }
}
