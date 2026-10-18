use crate::{auth::Account, emit, emit_game_log};
use anyhow::{anyhow, Result};
use futures::stream::{self, StreamExt};
use serde_json::Value;
use sha1::{Digest, Sha1};
use std::collections::VecDeque;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::sync::Mutex;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tauri::{AppHandle, Emitter, Manager};

const OS: &str = if cfg!(windows) {
    "windows"
} else if cfg!(target_os = "macos") {
    "osx"
} else {
    "linux"
};
const SEP: &str = if cfg!(windows) { ";" } else { ":" };
const MANIFEST: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("arca-tauri-launcher/0.1")
        .connect_timeout(std::time::Duration::from_secs(10))
        .read_timeout(std::time::Duration::from_secs(15)) // a stalled download errors out, then retries
        .build()
        .unwrap()
}

async fn get_json(c: &reqwest::Client, url: &str) -> Result<Value> {
    Ok(c.get(url).send().await?.error_for_status()?.json().await?)
}

async fn fetch_bytes(c: &reqwest::Client, url: &str) -> Result<Vec<u8>> {
    Ok(c.get(url)
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?
        .to_vec())
}

pub async fn download(c: &reqwest::Client, url: &str, path: &Path) -> Result<()> {
    download_checked(c, url, path, None, 5).await
}

async fn download_checked(
    c: &reqwest::Client,
    url: &str,
    path: &Path,
    expected_sha1: Option<&str>,
    attempts: u64,
) -> Result<()> {
    let is_valid = |candidate: &Path| {
        if !candidate.is_file() {
            return false;
        }
        expected_sha1.is_none_or(|expected| {
            sha1_file(candidate).is_ok_and(|actual| actual.eq_ignore_ascii_case(expected))
        })
    };
    if is_valid(path) {
        return Ok(());
    }
    if path.exists() {
        fs::remove_file(path)?;
    }
    if let Some(p) = path.parent() {
        fs::create_dir_all(p)?;
    }
    let mut last_err = None;
    for attempt in 0..attempts {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(500 * attempt)).await;
        }
        match fetch_bytes(c, url).await {
            Ok(b) => {
                if let Some(expected) = expected_sha1 {
                    let actual = format!("{:x}", Sha1::digest(&b));
                    if !actual.eq_ignore_ascii_case(expected) {
                        last_err = Some(anyhow!(
                            "SHA-1 mismatch for {url}: expected {expected}, got {actual}"
                        ));
                        continue;
                    }
                }
                let name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("download");
                let tmp =
                    path.with_file_name(format!("{name}.{}.part", uuid::Uuid::new_v4().simple()));
                if let Err(error) = fs::write(&tmp, &b) {
                    last_err = Some(error.into());
                    continue;
                }
                match fs::rename(&tmp, path) {
                    Ok(()) => return Ok(()),
                    Err(_error) if is_valid(path) => {
                        let _ = fs::remove_file(tmp);
                        return Ok(());
                    }
                    Err(error) => {
                        let _ = fs::remove_file(tmp);
                        last_err = Some(error.into());
                    }
                }
            }
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow!("Download failed without an attempt: {url}")))
}

fn sha1_file(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha1::new();
    let mut buffer = [0; 16 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct VersionInfo {
    pub id: String,
    pub kind: String, // release | snapshot | old_beta | old_alpha
}

/// Same as `download`, but tells the console when it has to retry and tries 8 times.
pub async fn download_logged(
    app: &AppHandle,
    c: &reqwest::Client,
    url: &str,
    path: &Path,
) -> Result<()> {
    download_logged_checked(app, c, url, path, None).await
}

async fn download_logged_checked(
    app: &AppHandle,
    c: &reqwest::Client,
    url: &str,
    path: &Path,
    expected_sha1: Option<&str>,
) -> Result<()> {
    for attempt in 1..=8u64 {
        match download_checked(c, url, path, expected_sha1, 1).await {
            Ok(()) => return Ok(()),
            Err(error) if attempt < 8 => {
                emit(
                    app,
                    format!(
                        "Retrying {} (attempt {}/8): {error}",
                        url.rsplit('/').next().unwrap_or(url),
                        attempt + 1
                    ),
                );
                tokio::time::sleep(std::time::Duration::from_millis(400 * attempt)).await;
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!()
}

pub async fn mc_versions() -> Result<Vec<VersionInfo>> {
    let m = get_json(&http(), MANIFEST).await?;
    Ok(m["versions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| {
            Some(VersionInfo {
                id: v["id"].as_str()?.into(),
                kind: v["type"].as_str()?.into(),
            })
        })
        .collect())
}

// ---------------------------------------------------------------- vanilla

pub async fn install_vanilla(
    app: &AppHandle,
    c: &reqwest::Client,
    dir: &Path,
    id: &str,
) -> Result<()> {
    let vdir = dir.join("versions").join(id);
    let jp = vdir.join(format!("{id}.json"));
    if !jp.exists() {
        emit(app, format!("Fetching Minecraft {id} metadata"));
        let m = get_json(c, MANIFEST).await?;
        let url = m["versions"]
            .as_array()
            .and_then(|a| a.iter().find(|v| v["id"] == id))
            .and_then(|v| v["url"].as_str())
            .ok_or_else(|| anyhow!("Unknown Minecraft version {id}"))?
            .to_string();
        let b = c
            .get(&url)
            .send()
            .await?
            .error_for_status()?
            .bytes()
            .await?;
        fs::create_dir_all(&vdir)?;
        fs::write(&jp, b)?;
    }
    let v: Value = serde_json::from_str(&fs::read_to_string(&jp)?)?;
    let url = v["downloads"]["client"]["url"]
        .as_str()
        .ok_or_else(|| anyhow!("No client download for {id}"))?;
    let sha1 = v["downloads"]["client"]["sha1"].as_str();
    emit(app, "Downloading client jar");
    download_checked(c, url, &vdir.join(format!("{id}.jar")), sha1, 5).await
}

// ---------------------------------------------------------------- loaders

pub async fn install_loader(
    app: &AppHandle,
    c: &reqwest::Client,
    dir: &Path,
    loader: &str,
    mc: &str,
    java: &str,
) -> Result<String> {
    match loader {
        "vanilla" => Ok(mc.to_string()),

        "fabric" | "quilt" => {
            let base = if loader == "fabric" {
                "https://meta.fabricmc.net/v2"
            } else {
                "https://meta.quiltmc.org/v3"
            };
            emit(app, format!("Resolving {loader} loader for {mc}"));
            let list = get_json(c, &format!("{base}/versions/loader/{mc}")).await?;
            let arr = list
                .as_array()
                .filter(|a| !a.is_empty())
                .ok_or_else(|| anyhow!("{loader} doesn't support Minecraft {mc}"))?;
            let pick = arr
                .iter()
                .find(|e| e["loader"]["stable"] == true)
                .unwrap_or(&arr[0]);
            let lv = pick["loader"]["version"]
                .as_str()
                .ok_or_else(|| anyhow!("bad loader list"))?;
            let profile =
                get_json(c, &format!("{base}/versions/loader/{mc}/{lv}/profile/json")).await?;
            let id = profile["id"]
                .as_str()
                .ok_or_else(|| anyhow!("bad loader profile"))?
                .to_string();
            let vdir = dir.join("versions").join(&id);
            fs::create_dir_all(&vdir)?;
            fs::write(
                vdir.join(format!("{id}.json")),
                serde_json::to_string(&profile)?,
            )?;
            Ok(id)
        }

        "forge" => {
            let promos = get_json(
                c,
                "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json",
            )
            .await?;
            let (rec, lat) = (format!("{mc}-recommended"), format!("{mc}-latest"));
            let fv = promos["promos"][&rec]
                .as_str()
                .or(promos["promos"][&lat].as_str())
                .ok_or_else(|| anyhow!("No Forge build for Minecraft {mc}"))?;
            let urls = forge_installer_urls(mc, fv);
            run_installer(app, c, dir, &urls, java, &format!("{mc}-forge-{fv}")).await
        }

        "neoforge" => {
            let rest = mc
                .strip_prefix("1.")
                .ok_or_else(|| anyhow!("NeoForge needs Minecraft 1.20.2+"))?;
            let mut it = rest.split('.');
            let prefix = format!("{}.{}.", it.next().unwrap_or("0"), it.next().unwrap_or("0"));
            let all = get_json(
                c,
                "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge",
            )
            .await?;
            let matching: Vec<&str> = all["versions"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str())
                .filter(|v| v.starts_with(&prefix))
                .collect();
            let nv = matching
                .iter()
                .rev()
                .find(|v| !v.contains("beta") && !v.contains("alpha"))
                .or(matching.last())
                .ok_or_else(|| anyhow!("No NeoForge build for Minecraft {mc}"))?;
            let url = format!("https://maven.neoforged.net/releases/net/neoforged/neoforge/{nv}/neoforge-{nv}-installer.jar");
            run_installer(app, c, dir, &[url], java, &format!("neoforge-{nv}")).await
        }

        other => Err(anyhow!("Unknown loader {other}")),
    }
}

fn forge_installer_urls(mc: &str, version: &str) -> [String; 2] {
    let ver = format!("{mc}-{version}");
    let legacy_ver = format!("{ver}-{mc}");
    [
        format!(
            "https://maven.minecraftforge.net/net/minecraftforge/forge/{ver}/forge-{ver}-installer.jar"
        ),
        format!(
            "https://maven.minecraftforge.net/net/minecraftforge/forge/{legacy_ver}/forge-{legacy_ver}-installer.jar"
        ),
    ]
}

fn version_dirs(dir: &Path) -> HashSet<String> {
    fs::read_dir(dir.join("versions"))
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| e.file_name().into_string().ok())
                .collect()
        })
        .unwrap_or_default()
}

async fn run_installer(
    app: &AppHandle,
    c: &reqwest::Client,
    dir: &Path,
    urls: &[String],
    java: &str,
    expected: &str,
) -> Result<String> {
    let exists = |id: &str| {
        dir.join("versions")
            .join(id)
            .join(format!("{id}.json"))
            .exists()
    };
    if exists(expected) {
        return Ok(expected.to_string());
    }
    emit(app, "Downloading loader installer");
    let installer_dir = dir
        .parent()
        .unwrap_or(dir)
        .join("launcher")
        .join("installers");
    let mut jar = None;
    let mut errors = Vec::new();
    for url in urls {
        let candidate = installer_dir.join(url.rsplit('/').next().unwrap_or("installer.jar"));
        match download(c, url, &candidate).await {
            Ok(()) => {
                jar = Some(candidate);
                break;
            }
            Err(error) => errors.push(format!("{url}: {error:#}")),
        }
    }
    let jar = jar.ok_or_else(|| {
        anyhow!(
            "Could not download loader installer from any known URL:\n{}",
            errors.join("\n")
        )
    })?;
    if let Some(id) = install_legacy_client_profile(&jar, dir)? {
        return Ok(id);
    }

    let lp = dir.join("launcher_profiles.json"); // older installers require this file
    if !lp.exists() {
        fs::write(&lp, r#"{"profiles":{}}"#)?;
    }
    let before = version_dirs(dir);
    emit(
        app,
        "Running loader installer (this can take a few minutes)...",
    );
    let mut cmd = tokio::process::Command::new(java);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd
        .arg("-jar")
        .arg(&jar)
        .arg("--installClient")
        .arg(dir)
        .current_dir(dir)
        .output()
        .await
        .map_err(|e| anyhow!("Could not run Java ({java}): {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let tail: Vec<&str> = err.lines().rev().take(8).collect();
        return Err(anyhow!(
            "Installer failed:\n{}",
            tail.into_iter().rev().collect::<Vec<_>>().join("\n")
        ));
    }
    if exists(expected) {
        return Ok(expected.to_string());
    }
    version_dirs(dir)
        .difference(&before)
        .next()
        .cloned()
        .ok_or_else(|| anyhow!("Installer finished but no new version was found"))
}

fn legacy_client_version(profile: &Value) -> Result<Option<(String, Value)>> {
    if profile["processors"]
        .as_array()
        .is_some_and(|processors| !processors.is_empty())
    {
        return Ok(None);
    }
    let Some(mut version) = profile
        .get("versionInfo")
        .filter(|v| v.is_object())
        .cloned()
    else {
        return Ok(None);
    };
    let id = version["id"]
        .as_str()
        .ok_or_else(|| anyhow!("Legacy installer profile is missing versionInfo.id"))?
        .to_string();
    if id.is_empty()
        || !id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
    {
        anyhow::bail!("Legacy installer profile has an invalid version id");
    }

    let install_path = profile["install"]["path"].as_str();
    let universal_jar = profile["install"]["filePath"]
        .as_str()
        .is_some_and(|file| file.ends_with("-universal.jar"));
    if universal_jar {
        if let (Some(path), Some(libraries)) = (install_path, version["libraries"].as_array_mut()) {
            if let Some(library) = libraries
                .iter_mut()
                .find(|library| library["name"].as_str() == Some(path))
            {
                library["name"] = format!("{path}:universal").into();
            }
        }
    }

    Ok(Some((id, version)))
}

fn install_legacy_client_profile(installer: &Path, dir: &Path) -> Result<Option<String>> {
    let mut archive = zip::ZipArchive::new(fs::File::open(installer)?)?;
    let profile = {
        let mut entry = match archive.by_name("install_profile.json") {
            Ok(entry) => entry,
            Err(zip::result::ZipError::FileNotFound) => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let mut contents = String::new();
        entry.read_to_string(&mut contents)?;
        serde_json::from_str::<Value>(&contents)?
    };
    let Some((id, version)) = legacy_client_version(&profile)? else {
        return Ok(None);
    };
    let version_dir = dir.join("versions").join(&id);
    fs::create_dir_all(&version_dir)?;
    fs::write(
        version_dir.join(format!("{id}.json")),
        serde_json::to_vec(&version)?,
    )?;
    Ok(Some(id))
}

// ---------------------------------------------------------------- version json

fn rules_ok(rules: Option<&Value>) -> bool {
    let Some(arr) = rules.and_then(|r| r.as_array()) else {
        return true;
    };
    let mut ok = false;
    for r in arr {
        let allow = r["action"] == "allow";
        let mut m = true;
        if let Some(os) = r.get("os") {
            if let Some(n) = os["name"].as_str() {
                if n != OS {
                    m = false;
                }
            }
            if os["arch"].as_str() == Some("x86") && !cfg!(target_arch = "x86") {
                m = false;
            }
        }
        if r.get("features").is_some() {
            m = false;
        } // demo mode, custom resolution, ...
        if m {
            ok = allow;
        }
    }
    ok
}

fn lib_key(l: &Value) -> String {
    let n = l["name"].as_str().unwrap_or("");
    let p: Vec<&str> = n.split(':').collect();
    format!(
        "{}:{}:{}",
        p.first().unwrap_or(&""),
        p.get(1).unwrap_or(&""),
        p.get(3).unwrap_or(&"")
    )
}

fn read_json(dir: &Path, id: &str) -> Result<Value> {
    let p = dir.join("versions").join(id).join(format!("{id}.json"));
    Ok(serde_json::from_str(
        &fs::read_to_string(&p).map_err(|e| anyhow!("{}: {e}", p.display()))?,
    )?)
}

/// Loads a version json and merges it with its `inheritsFrom` chain.
pub fn resolve(dir: &Path, id: &str) -> Result<Value> {
    let child = read_json(dir, id)?;
    let Some(parent_id) = child["inheritsFrom"].as_str() else {
        return Ok(child);
    };
    let parent = resolve(dir, parent_id)?;
    let mut out = parent.clone();
    for (k, v) in child.as_object().unwrap() {
        if k != "libraries" && k != "arguments" {
            out[k] = v.clone();
        }
    }
    let mut seen = HashSet::new();
    let libs: Vec<Value> = child["libraries"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(parent["libraries"].as_array().into_iter().flatten())
        .filter(|l| seen.insert(lib_key(l)))
        .cloned()
        .collect();
    out["libraries"] = Value::Array(libs);
    for kind in ["game", "jvm"] {
        let mut a = parent["arguments"][kind]
            .as_array()
            .cloned()
            .unwrap_or_default();
        a.extend(
            child["arguments"][kind]
                .as_array()
                .cloned()
                .unwrap_or_default(),
        );
        if !a.is_empty() {
            out["arguments"][kind] = Value::Array(a);
        }
    }
    Ok(out)
}

/// Which version folder holds the client jar.
fn jar_id(dir: &Path, id: &str) -> Result<String> {
    let v = read_json(dir, id)?;
    if let Some(j) = v["jar"].as_str() {
        return Ok(j.into());
    }
    match v["inheritsFrom"].as_str() {
        Some(p) => jar_id(dir, p),
        None => Ok(id.into()),
    }
}

// ---------------------------------------------------------------- libraries & assets

struct LibFile {
    path: String,
    url: String,
    sha1: Option<String>,
    native: bool,
}

fn maven_path(name: &str) -> String {
    let p: Vec<&str> = name.split(':').collect();
    let (g, a, v) = (p[0].replace('.', "/"), p[1], p[2]);
    match p.get(3) {
        Some(cl) => format!("{g}/{a}/{v}/{a}-{v}-{cl}.jar"),
        None => format!("{g}/{a}/{v}/{a}-{v}.jar"),
    }
}

fn collect_libs(v: &Value) -> Vec<LibFile> {
    let mut out = vec![];
    for l in v["libraries"].as_array().into_iter().flatten() {
        if !rules_ok(l.get("rules")) {
            continue;
        }
        if let Some(a) = l["downloads"].get("artifact") {
            if let Some(p) = a["path"].as_str() {
                out.push(LibFile {
                    path: p.into(),
                    url: a["url"].as_str().unwrap_or("").into(),
                    sha1: a["sha1"].as_str().map(String::from),
                    native: false,
                });
            }
        } else if l.get("downloads").is_none() {
            if let Some(name) = l["name"].as_str() {
                let mut base = l["url"]
                    .as_str()
                    .unwrap_or("https://libraries.minecraft.net/")
                    .to_string();
                if !base.ends_with('/') {
                    base.push('/');
                }
                let p = maven_path(name);
                out.push(LibFile {
                    url: format!("{base}{p}"),
                    path: p,
                    sha1: None,
                    native: false,
                });
            }
        }
        if let Some(cls) = l["natives"][OS].as_str() {
            let cls = cls.replace("${arch}", "64");
            if let Some(a) = l["downloads"]["classifiers"].get(&cls) {
                if let Some(p) = a["path"].as_str() {
                    out.push(LibFile {
                        path: p.into(),
                        url: a["url"].as_str().unwrap_or("").into(),
                        sha1: a["sha1"].as_str().map(String::from),
                        native: true,
                    });
                }
            }
        }
    }
    out
}

fn extract_natives(jar: &Path, out: &Path) -> Result<()> {
    fs::create_dir_all(out)?;
    let mut z = zip::ZipArchive::new(fs::File::open(jar)?)?;
    for i in 0..z.len() {
        let mut f = z.by_index(i)?;
        let name = f.name().to_string();
        if f.is_dir() || name.starts_with("META-INF") {
            continue;
        }
        let Some(fname) = Path::new(&name).file_name() else {
            continue;
        };
        let mut o = fs::File::create(out.join(fname))?;
        std::io::copy(&mut f, &mut o)?;
    }
    Ok(())
}

pub async fn install_deps(
    app: &AppHandle,
    c: &reqwest::Client,
    dir: &Path,
    id: &str,
    v: &Value,
    inst: &Path,
) -> Result<()> {
    // libraries
    let libs_dir = dir.join("libraries");
    let files = collect_libs(v);
    let jobs: Vec<(String, PathBuf, Option<String>)> = files
        .iter()
        .filter(|f| !f.url.is_empty())
        .map(|f| (f.url.clone(), libs_dir.join(&f.path), f.sha1.clone()))
        .collect();
    let total = jobs.len();
    emit(app, format!("Downloading {total} libraries"));
    let done = Arc::new(AtomicUsize::new(0));
    let results: Vec<Result<()>> = stream::iter(jobs)
        .map(|(url, path, sha1)| {
            let c = c.clone();
            let done = done.clone();
            let app = app.clone();
            async move {
                let r = download_logged_checked(&app, &c, &url, &path, sha1.as_deref()).await;
                let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                if n % 5 == 0 || n == total {
                    emit(&app, format!("Libraries {n}/{total}"));
                }
                r
            }
        })
        .buffer_unordered(8)
        .collect()
        .await;
    for r in results {
        r?;
    }

    // legacy natives
    let natives_dir = dir.join("versions").join(id).join("natives");
    for f in files.iter().filter(|f| f.native) {
        extract_natives(&libs_dir.join(&f.path), &natives_dir)?;
    }

    // assets
    let ai = &v["assetIndex"];
    let (ai_id, ai_url) = (
        ai["id"].as_str().ok_or_else(|| anyhow!("no assetIndex"))?,
        ai["url"].as_str().unwrap_or(""),
    );
    let index_path = dir
        .join("assets")
        .join("indexes")
        .join(format!("{ai_id}.json"));
    download_checked(c, ai_url, &index_path, ai["sha1"].as_str(), 5).await?;
    let index: Value = serde_json::from_str(&fs::read_to_string(&index_path)?)?;
    let objects: Vec<String> = index["objects"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(_, o)| o["hash"].as_str().map(String::from))
        .collect();
    let total = objects.len();
    emit(
        app,
        format!("Downloading {total} assets (already-downloaded files are skipped)"),
    );
    let done = Arc::new(AtomicUsize::new(0));
    let results: Vec<Result<()>> = stream::iter(objects)
        .map(|h| {
            let c = c.clone();
            let done = done.clone();
            let app = app.clone();
            let path = dir.join("assets").join("objects").join(&h[..2]).join(&h);
            let url = format!("https://resources.download.minecraft.net/{}/{}", &h[..2], h);
            async move {
                let r = download_logged_checked(&app, &c, &url, &path, Some(&h)).await;
                let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                if n % 10 == 0 || n == total {
                    emit(&app, format!("Assets {n}/{total}"));
                }
                r
            }
        })
        .buffer_unordered(8)
        .collect()
        .await;
    for r in results {
        r?;
    }

    // very old versions (pre-1.7) read sounds from a "virtual" folder or <game dir>/resources
    let is_virtual = index["virtual"].as_bool().unwrap_or(false);
    let to_resources = index["map_to_resources"].as_bool().unwrap_or(false);
    if is_virtual || to_resources {
        for (name, o) in index["objects"].as_object().into_iter().flatten() {
            let Some(h) = o["hash"].as_str() else {
                continue;
            };
            let src = dir.join("assets").join("objects").join(&h[..2]).join(h);
            let mut targets = vec![];
            if is_virtual {
                targets.push(dir.join("assets").join("virtual").join(ai_id).join(name));
            }
            if to_resources {
                targets.push(inst.join("resources").join(name));
            }
            for t in targets {
                if !t.exists() {
                    if let Some(p) = t.parent() {
                        fs::create_dir_all(p)?;
                    }
                    let _ = fs::copy(&src, &t);
                }
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- launching

fn sub(s: &str, vars: &HashMap<&str, String>) -> String {
    let mut out = s.to_string();
    for (k, val) in vars {
        out = out.replace(&format!("${{{k}}}"), val);
    }
    out
}

fn expand(a: &Value, vars: &HashMap<&str, String>) -> Vec<String> {
    match a {
        Value::String(s) => vec![sub(s, vars)],
        Value::Object(o) => {
            if !rules_ok(o.get("rules")) {
                return vec![];
            }
            match &o["value"] {
                Value::String(s) => vec![sub(s, vars)],
                Value::Array(arr) => arr
                    .iter()
                    .filter_map(|x| x.as_str())
                    .map(|s| sub(s, vars))
                    .collect(),
                _ => vec![],
            }
        }
        _ => vec![],
    }
}

fn expand_jvm_arg(a: &Value, vars: &HashMap<&str, String>, id: &str, jar_id: &str) -> Vec<String> {
    let profile_jar = format!("{id}.jar");
    let client_jar = format!("{jar_id}.jar");
    expand(a, vars)
        .into_iter()
        .map(|arg| {
            if arg.starts_with("-DignoreList=") {
                arg.replace(&profile_jar, &client_jar)
            } else {
                arg
            }
        })
        .collect()
}

#[cfg(test)]
mod launch_argument_tests {
    use super::{
        expand, expand_jvm_arg, forge_installer_urls, legacy_client_version, maven_path, sha1_file,
    };
    use serde_json::json;
    use std::collections::HashMap;

    #[test]
    fn neoforge_ignore_list_uses_the_inherited_client_jar() {
        let vars = HashMap::from([("version_name", "neoforge-21.1.262".to_string())]);
        let ignore_list = json!("-DignoreList=client-extra,${version_name}.jar");

        assert_eq!(
            expand_jvm_arg(&ignore_list, &vars, "neoforge-21.1.262", "1.21.1"),
            ["-DignoreList=client-extra,1.21.1.jar"]
        );
        assert_eq!(expand(&json!("--version"), &vars), ["--version"]);
        assert_eq!(
            expand(&json!("${version_name}"), &vars),
            ["neoforge-21.1.262"]
        );
    }

    #[test]
    fn forge_installer_urls_include_legacy_minecraft_coordinate() {
        let urls = forge_installer_urls("1.7.10", "10.13.4.1614");
        assert!(urls[0].ends_with("/1.7.10-10.13.4.1614/forge-1.7.10-10.13.4.1614-installer.jar"));
        assert!(urls[1].ends_with(
            "/1.7.10-10.13.4.1614-1.7.10/forge-1.7.10-10.13.4.1614-1.7.10-installer.jar"
        ));
    }

    #[test]
    fn legacy_forge_profile_installs_universal_library_without_client_flag() {
        let profile = json!({
            "install": {
                "path": "net.minecraftforge:forge:1.7.10-10.13.4.1614-1.7.10",
                "filePath": "forge-1.7.10-10.13.4.1614-1.7.10-universal.jar"
            },
            "versionInfo": {
                "id": "1.7.10-Forge10.13.4.1614-1.7.10",
                "inheritsFrom": "1.7.10",
                "libraries": [{
                    "name": "net.minecraftforge:forge:1.7.10-10.13.4.1614-1.7.10",
                    "url": "https://maven.minecraftforge.net/"
                }]
            }
        });

        let (id, version) = legacy_client_version(&profile).unwrap().unwrap();
        assert_eq!(id, "1.7.10-Forge10.13.4.1614-1.7.10");
        let library = &version["libraries"][0]["name"];
        assert_eq!(
            library,
            "net.minecraftforge:forge:1.7.10-10.13.4.1614-1.7.10:universal"
        );
        assert_eq!(
            maven_path(library.as_str().unwrap()),
            "net/minecraftforge/forge/1.7.10-10.13.4.1614-1.7.10/forge-1.7.10-10.13.4.1614-1.7.10-universal.jar"
        );
    }

    #[test]
    fn processor_based_installers_still_use_the_installer_cli() {
        let profile = json!({
            "processors": [{"jar": "example:processor:1.0"}],
            "versionInfo": {"id": "forge-example"}
        });
        assert!(legacy_client_version(&profile).unwrap().is_none());
    }

    #[test]
    fn downloaded_file_sha1_matches_mojang_checksum_format() {
        let path = std::env::temp_dir().join(format!("arca-sha1-{}.tmp", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"abc").unwrap();
        assert_eq!(
            sha1_file(&path).unwrap(),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
        std::fs::remove_file(path).unwrap();
    }
}

pub struct LaunchOpts {
    pub jvm_args: Vec<String>,
    pub game_args: Vec<String>,
    pub hide: String, // "keep" | "hide" | "close"
    pub volume: Option<u32>,
}

fn asset_flags(dir: &Path, v: &Value) -> (String, bool) {
    let id = v["assetIndex"]["id"].as_str().unwrap_or("").to_string();
    let idx: Value = fs::read_to_string(
        dir.join("assets")
            .join("indexes")
            .join(format!("{id}.json")),
    )
    .ok()
    .and_then(|s| serde_json::from_str(&s).ok())
    .unwrap_or(Value::Null);
    let virt = idx["virtual"].as_bool().unwrap_or(false);
    (id, virt)
}

/// Writes the master volume into options.txt (0-100).
fn set_volume(inst: &Path, vol: u32) {
    let p = inst.join("options.txt");
    let line = format!("soundCategory_master:{:.2}", vol.min(100) as f32 / 100.0);
    let text = fs::read_to_string(&p).unwrap_or_default();
    let mut found = false;
    let mut lines: Vec<String> = text
        .lines()
        .map(|l| {
            if l.starts_with("soundCategory_master:") {
                found = true;
                line.clone()
            } else {
                l.to_string()
            }
        })
        .collect();
    if !found {
        lines.push(line);
    }
    let _ = fs::write(&p, lines.join("\n") + "\n");
}

pub fn launch(
    app: &AppHandle,
    dir: &Path,
    id: &str,
    v: &Value,
    acc: &Account,
    ram: u32,
    java: &str,
    inst: &Path,
    o: &LaunchOpts,
) -> Result<()> {
    let libs_dir = dir.join("libraries");
    let jid = jar_id(dir, id)?;
    let client_jar = dir.join("versions").join(&jid).join(format!("{jid}.jar"));

    let mut seen = HashSet::new();
    let mut cp: Vec<String> = collect_libs(v)
        .iter()
        .filter(|f| !f.native)
        .map(|f| libs_dir.join(&f.path).to_string_lossy().to_string())
        .filter(|p| seen.insert(p.clone()))
        .collect();
    cp.push(client_jar.to_string_lossy().to_string());

    for sub in ["mods", "resourcepacks", "shaderpacks", "saves", "datapacks"] {
        fs::create_dir_all(inst.join(sub))?;
    }
    if let Some(vol) = o.volume {
        set_volume(&inst, vol);
    }
    let (ai_id, is_virtual) = asset_flags(dir, v);
    let game_assets = if is_virtual {
        dir.join("assets").join("virtual").join(&ai_id)
    } else {
        dir.join("assets")
    };

    let s = |p: PathBuf| p.to_string_lossy().to_string();
    let mut vars: HashMap<&str, String> = HashMap::new();
    vars.insert("auth_player_name", acc.username.clone());
    vars.insert("auth_uuid", acc.uuid.clone());
    vars.insert("auth_access_token", acc.token.clone());
    vars.insert("auth_session", acc.token.clone());
    vars.insert("user_type", acc.user_type.clone());
    vars.insert("user_properties", "{}".into());
    vars.insert("version_name", id.into());
    vars.insert(
        "version_type",
        v["type"].as_str().unwrap_or("release").into(),
    );
    vars.insert("game_directory", s(inst.to_path_buf()));
    vars.insert("assets_root", s(dir.join("assets")));
    vars.insert("game_assets", s(game_assets));
    vars.insert("assets_index_name", ai_id);
    vars.insert(
        "natives_directory",
        s(dir.join("versions").join(id).join("natives")),
    );
    vars.insert("library_directory", s(libs_dir.clone()));
    vars.insert("classpath_separator", SEP.into());
    vars.insert("classpath", cp.join(SEP));
    vars.insert("launcher_name", "ArcaTauriLauncher".into());
    vars.insert("launcher_version", "0.1.1".into());
    vars.insert("clientid", "".into());
    vars.insert("auth_xuid", "".into());

    let jvm: Vec<String> = match v["arguments"]["jvm"].as_array() {
        Some(a) => a
            .iter()
            .flat_map(|x| expand_jvm_arg(x, &vars, id, &jid))
            .collect(),
        None => vec![
            sub("-Djava.library.path=${natives_directory}", &vars),
            "-cp".into(),
            sub("${classpath}", &vars),
        ],
    };
    let game: Vec<String> = match v["arguments"]["game"].as_array() {
        Some(a) => a.iter().flat_map(|x| expand(x, &vars)).collect(),
        None => v["minecraftArguments"]
            .as_str()
            .unwrap_or("")
            .split_whitespace()
            .map(|x| sub(x, &vars))
            .collect(),
    };
    let main_class = v["mainClass"]
        .as_str()
        .ok_or_else(|| anyhow!("mainClass missing"))?;

    // user JVM args come after the defaults, so e.g. their own -Xmx wins
    let mut cmd = Command::new(java);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.arg(format!("-Xmx{ram}M"))
        .args(&acc.jvm)
        .args(&jvm)
        .args(&o.jvm_args)
        .arg(main_class)
        .args(&game)
        .args(&o.game_args)
        .current_dir(&inst);
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let log_buf: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::with_capacity(220)));
    if let Some(out) = child.stdout.take() {
        let app = app.clone();
        let buf = log_buf.clone();
        std::thread::spawn(move || {
            for l in BufReader::new(out).lines().flatten() {
                emit_game_log(&app, l.clone());
                let mut b = buf.lock().unwrap();
                if b.len() >= 200 {
                    b.pop_front();
                }
                b.push_back(l);
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        let app = app.clone();
        let buf = log_buf.clone();
        std::thread::spawn(move || {
            for l in BufReader::new(err).lines().flatten() {
                emit_game_log(&app, l.clone());
                let mut b = buf.lock().unwrap();
                if b.len() >= 200 {
                    b.pop_front();
                }
                b.push_back(l);
            }
        });
    }

    let app2 = app.clone();
    let restore = o.hide == "hide";
    let inst2 = inst.to_path_buf();
    let launch_time = std::time::SystemTime::now();
    std::thread::spawn(move || {
        let status = child.wait().ok();
        let code = status.as_ref().and_then(|s| s.code());
        emit(
            &app2,
            format!(
                "Game exited (code {})",
                code.map(|c| c.to_string()).unwrap_or_else(|| "?".into())
            ),
        );

        if code != Some(0) {
            let report = find_crash_report(&inst2, launch_time);
            let tail: Vec<String> = log_buf.lock().unwrap().iter().cloned().collect();
            let _ = app2.emit(
                "game-crash",
                serde_json::json!({
                    "code": code,
                    "log_tail": tail,
                    "crash_report": report,
                }),
            );
        }

        if restore {
            if let Some(w) = app2.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
    });

    match o.hide.as_str() {
        "hide" => {
            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = window.hide() {
                    emit(&app, format!("Could not hide the launcher window: {error}"));
                }
            }
        }
        "close" => {
            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = window.close() {
                    emit(
                        &app,
                        format!("Could not close the launcher window: {error}"),
                    );
                }
            }
        }
        _ => {}
    }
    Ok(())
}

#[derive(serde::Serialize)]
struct CrashReport {
    path: String,
    content: String,
}

/// Newest crash-reports/*.txt written since launch, if any — Minecraft writes one on most
/// in-game crashes (not on e.g. a missing-library exit, where the log tail is all you get).
fn find_crash_report(inst: &Path, after: std::time::SystemTime) -> Option<CrashReport> {
    let dir = inst.join("crash-reports");
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in fs::read_dir(&dir).ok()?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("txt") {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|m| m.modified()) else {
            continue;
        };
        if modified < after {
            continue;
        }
        if best.as_ref().map(|(t, _)| modified > *t).unwrap_or(true) {
            best = Some((modified, path));
        }
    }
    let (_, path) = best?;
    let mut content = fs::read_to_string(&path).ok()?;
    if content.len() > 20_000 {
        content.truncate(20_000);
        content.push_str("\n\n[truncated]");
    }
    Some(CrashReport {
        path: path.to_string_lossy().to_string(),
        content,
    })
}

/// Creates the standard folders inside an instance.
pub fn prepare_instance(inst: &Path) -> Result<()> {
    for sub in ["mods", "resourcepacks", "shaderpacks", "saves", "datapacks"] {
        fs::create_dir_all(inst.join(sub))?;
    }
    Ok(())
}

/// Which loaders have a build for this Minecraft version (vanilla always).
pub async fn loader_support(mc: &str) -> Vec<String> {
    let c = http();
    let fab_url = format!("https://meta.fabricmc.net/v2/versions/loader/{mc}");
    let quilt_url = format!("https://meta.quiltmc.org/v3/versions/loader/{mc}");
    let (fab, quilt, forge, neo) = futures::join!(
        get_json(&c, &fab_url),
        get_json(&c, &quilt_url),
        get_json(
            &c,
            "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json"
        ),
        get_json(
            &c,
            "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge"
        ),
    );
    // if a lookup fails (offline, server down) we don't block the loader
    let has_items = |r: &Result<Value>| match r {
        Ok(v) => v.as_array().map(|a| !a.is_empty()).unwrap_or(false),
        Err(_) => true,
    };
    let mut out = vec!["vanilla".to_string()];
    if has_items(&fab) {
        out.push("fabric".into());
    }
    if has_items(&quilt) {
        out.push("quilt".into());
    }
    let forge_ok = match &forge {
        Ok(v) => {
            !v["promos"][format!("{mc}-latest")].is_null()
                || !v["promos"][format!("{mc}-recommended")].is_null()
        }
        Err(_) => true,
    };
    if forge_ok {
        out.push("forge".into());
    }
    let neo_ok = match &neo {
        Ok(v) => match mc.strip_prefix("1.") {
            Some(rest) => {
                let mut it = rest.split('.');
                let prefix = format!("{}.{}.", it.next().unwrap_or("0"), it.next().unwrap_or("0"));
                v["versions"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.as_str())
                            .any(|x| x.starts_with(&prefix))
                    })
                    .unwrap_or(false)
            }
            None => false,
        },
        Err(_) => true,
    };
    if neo_ok {
        out.push("neoforge".into());
    }
    out
}
