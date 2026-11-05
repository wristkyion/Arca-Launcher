use crate::{instances, Instance};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    io::{Read, Seek, Write},
    path::{Component, Path, PathBuf},
};
use tauri::{AppHandle, Emitter};
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

const MAX_ARCHIVE_ENTRIES: usize = 100_000;
const MAX_EXTRACTED_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MAX_METADATA_BYTES: u64 = 1024 * 1024;

#[derive(Serialize)]
pub struct ArchiveInfo {
    has_metadata: bool,
    name: String,
    loader: String,
    mc: String,
}

#[derive(Deserialize)]
pub struct ImportArchiveReq {
    path: String,
    fallback_name: String,
    fallback_loader: String,
    fallback_mc: String,
    java: String,
    java_mode: String,
    task_id: String,
}

#[derive(Deserialize)]
pub struct RemoveInstancesReq {
    ids: Vec<String>,
}

fn archive_error(error: impl std::fmt::Display) -> String {
    format!("Instance archive operation failed: {error}")
}

fn validate_archive<R: Read + Seek>(archive: &mut ZipArchive<R>) -> Result<(), String> {
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("The archive contains too many files".into());
    }
    let mut expanded_bytes = 0u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| archive_error(error))?;
        let path = entry
            .enclosed_name()
            .ok_or_else(|| format!("Unsafe archive path: {}", entry.name()))?;
        if !safe_archive_path(&path) {
            return Err(format!("Unsafe archive path: {}", entry.name()));
        }
        if !entry.is_dir()
            && !entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            expanded_bytes = expanded_bytes.saturating_add(entry.size());
            if expanded_bytes > MAX_EXTRACTED_BYTES {
                return Err("The archive expands beyond the 16 GiB import limit".into());
            }
        }
    }
    Ok(())
}

fn archive_metadata_path<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
) -> Result<Option<String>, String> {
    let mut root = false;
    let mut nested = Vec::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| archive_error(error))?;
        let name = entry.name().trim_end_matches('/');
        if name == instances::META_FILE {
            root = true;
        } else if let Some(prefix) = name.strip_suffix(&format!("/{0}", instances::META_FILE)) {
            if !prefix.is_empty() && !prefix.contains('/') {
                nested.push(prefix.to_string());
            }
        }
    }

    if root {
        return Ok(Some(String::new()));
    }
    nested.sort();
    nested.dedup();
    match nested.as_slice() {
        [prefix] => Ok(Some(format!("{prefix}/"))),
        [] => Ok(None),
        _ => Err("The archive contains multiple possible instance roots".into()),
    }
}

fn read_metadata<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    prefix: &str,
) -> Result<Value, String> {
    let name = format!("{prefix}{}", instances::META_FILE);
    let mut file = archive
        .by_name(&name)
        .map_err(|error| format!("Could not read {name}: {error}"))?;
    if file.size() > MAX_METADATA_BYTES {
        return Err("The instance metadata file is too large".into());
    }
    let mut contents = String::new();
    file.read_to_string(&mut contents)
        .map_err(|error| format!("Could not read instance metadata: {error}"))?;
    serde_json::from_str(&contents)
        .map_err(|error| format!("Could not parse instance metadata: {error}"))
}

fn archive_single_root_prefix<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
) -> Result<Option<String>, String> {
    let mut root: Option<String> = None;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| archive_error(error))?;
        let name = entry.name().trim_end_matches('/');
        let Some((first, _)) = name.split_once('/') else {
            return Ok(None);
        };
        if first.is_empty() || root.as_deref().is_some_and(|value| value != first) {
            return Ok(None);
        }
        root.get_or_insert_with(|| first.to_string());
    }
    Ok(root.map(|prefix| format!("{prefix}/")))
}

#[tauri::command]
pub fn inspect_instance_archive(path: String) -> Result<ArchiveInfo, String> {
    let mut archive =
        ZipArchive::new(fs::File::open(&path).map_err(archive_error)?).map_err(archive_error)?;
    let prefix = archive_metadata_path(&mut archive)?;
    if let Some(prefix) = prefix {
        let metadata = read_metadata(&mut archive, &prefix)?;
        return Ok(ArchiveInfo {
            has_metadata: true,
            name: metadata["name"].as_str().unwrap_or("").to_string(),
            loader: metadata["loader"].as_str().unwrap_or("vanilla").to_string(),
            mc: metadata["mc"].as_str().unwrap_or("").to_string(),
        });
    }
    let name = Path::new(&path)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Imported instance")
        .to_string();
    Ok(ArchiveInfo {
        has_metadata: false,
        name,
        loader: "vanilla".into(),
        mc: String::new(),
    })
}

fn safe_archive_path(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn metadata_string(metadata: &Value, key: &str, fallback: &str) -> String {
    metadata[key]
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

#[tauri::command]
pub async fn import_instance_archive(
    app: AppHandle,
    req: ImportArchiveReq,
) -> Result<Vec<Instance>, String> {
    let task_id = req.task_id.clone();
    let task = async move { import_archive(app, req).await.map_err(anyhow::Error::msg) };
    crate::with_cancellable_install(task_id, task)
        .await
        .map_err(|error| format!("{error:#}"))
}

async fn import_archive(app: AppHandle, req: ImportArchiveReq) -> Result<Vec<Instance>, String> {
    let mut archive = ZipArchive::new(fs::File::open(&req.path).map_err(archive_error)?)
        .map_err(archive_error)?;
    validate_archive(&mut archive)?;
    let prefix = archive_metadata_path(&mut archive)?;
    let metadata = prefix
        .as_deref()
        .map(|prefix| read_metadata(&mut archive, prefix))
        .transpose()?
        .unwrap_or(Value::Null);
    let import_prefix = match prefix {
        Some(prefix) => Some(prefix),
        None => archive_single_root_prefix(&mut archive)?,
    };
    drop(archive);

    let name = metadata_string(&metadata, "name", req.fallback_name.trim());
    let loader = metadata_string(&metadata, "loader", req.fallback_loader.trim());
    let mc = metadata_string(&metadata, "mc", req.fallback_mc.trim());
    if name.is_empty() || mc.is_empty() {
        return Err("Enter an instance name and Minecraft version".into());
    }
    if !matches!(
        loader.as_str(),
        "vanilla" | "fabric" | "forge" | "neoforge" | "quilt"
    ) {
        return Err(format!("Unsupported mod loader: {loader}"));
    }
    if name.chars().count() > 120 || mc.len() > 64 {
        return Err("The instance name or Minecraft version is too long".into());
    }

    let root = crate::instance_root()?;
    fs::create_dir_all(&root).map_err(archive_error)?;
    let base = crate::slug(&name);
    let mut id = base.clone();
    let mut suffix = 2;
    while root.join(&id).exists() {
        id = format!("{base}-{suffix}");
        suffix += 1;
    }
    let (game_dir, _, _) = crate::setup_dirs();
    let client = crate::game::http();
    let java = crate::pick_java(&app, &req.java, &req.java_mode, &mc)
        .await
        .map_err(|error| format!("{error:#}"))?;
    crate::emit(&app, "Preparing imported instance...");
    crate::game::install_vanilla(&app, &client, &game_dir, &mc)
        .await
        .map_err(|error| format!("{error:#}"))?;
    let version_id = crate::game::install_loader(&app, &client, &game_dir, &loader, &mc, &java)
        .await
        .map_err(|error| format!("{error:#}"))?;
    let version =
        crate::game::resolve(&game_dir, &version_id).map_err(|error| format!("{error:#}"))?;

    let staged = instances::InstallDirectory::new(
        root.join(format!(".import-{}", uuid::Uuid::new_v4().simple())),
    )?;
    let destination = root.join(&id);
    let instance_dir = staged.path();
    crate::game::install_deps(
        &app,
        &client,
        &game_dir,
        &version_id,
        &version,
        instance_dir,
    )
    .await
    .map_err(|error| format!("{error:#}"))?;
    crate::game::prepare_instance(instance_dir).map_err(archive_error)?;

    let mut archive = ZipArchive::new(fs::File::open(&req.path).map_err(archive_error)?)
        .map_err(archive_error)?;
    validate_archive(&mut archive)?;
    let mut extracted_bytes = 0u64;
    let total_entries = archive.len();
    let progress_interval = (total_entries / 100).max(1);
    crate::emit(&app, format!("Files 0/{total_entries}"));
    let prefix_path = import_prefix
        .as_deref()
        .map(|value| Path::new(value.trim_end_matches('/')));

    for index in 0..archive.len() {
        if index % progress_interval == 0 || index + 1 == total_entries {
            crate::emit(&app, format!("Files {}/{total_entries}", index + 1));
        }
        let mut entry = archive
            .by_index(index)
            .map_err(|error| archive_error(error))?;
        let enclosed = entry
            .enclosed_name()
            .ok_or_else(|| format!("Unsafe archive path: {}", entry.name()))?
            .to_path_buf();
        if !safe_archive_path(&enclosed) {
            return Err(format!("Unsafe archive path: {}", entry.name()));
        }
        let relative = match prefix_path {
            Some(prefix) => match enclosed.strip_prefix(prefix) {
                Ok(relative) => relative.to_path_buf(),
                Err(_) => continue,
            },
            None => enclosed,
        };
        if !safe_archive_path(&relative) || relative == Path::new(instances::META_FILE) {
            continue;
        }
        if entry.is_dir() {
            fs::create_dir_all(instance_dir.join(relative)).map_err(archive_error)?;
            continue;
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            continue;
        }
        extracted_bytes = extracted_bytes.saturating_add(entry.size());
        if extracted_bytes > MAX_EXTRACTED_BYTES {
            return Err("The archive expands beyond the 16 GiB import limit".into());
        }
        let output = instance_dir.join(relative);
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(archive_error)?;
        }
        let mut file = fs::File::create(output).map_err(archive_error)?;
        std::io::copy(&mut entry, &mut file).map_err(archive_error)?;
    }

    let instance = Instance {
        id: id.clone(),
        name,
        loader,
        mc: mc.clone(),
        version_id,
        icon: metadata_string(&metadata, "icon", ""),
        description: metadata_string(&metadata, "description", ""),
        background: metadata_string(&metadata, "background", ""),
    };
    instances::write_one(instance_dir, &instance)?;
    staged.commit(&destination)?;
    let mut list = instances::scan_all(&root);
    list.retain(|entry| entry.id != id);
    list.push(instance);
    Ok(list)
}

#[tauri::command]
pub async fn export_instance(
    app: AppHandle,
    id: String,
    path: String,
    task_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || export_archive(&app, &task_id, &id, &path))
        .await
        .map_err(|error| format!("Export task failed: {error}"))?
}

fn export_archive(
    app: &AppHandle,
    task_id: &str,
    id: &str,
    destination: &str,
) -> Result<(), String> {
    if id.is_empty() || id.contains(['/', '\\']) || id == "." || id == ".." {
        return Err("Invalid instance ID".into());
    }
    let root = crate::instance_root()?;
    let source = root.join(id);
    if instances::read_one(&source)?.is_none() {
        return Err("Instance not found".into());
    }
    let destination = PathBuf::from(destination);
    let parent = destination
        .parent()
        .ok_or_else(|| "Choose a destination folder for the archive".to_string())?
        .canonicalize()
        .map_err(archive_error)?;
    let source = source.canonicalize().map_err(archive_error)?;
    let output_path = parent.join(
        destination
            .file_name()
            .ok_or_else(|| "Choose a ZIP filename".to_string())?,
    );
    if output_path.starts_with(&source) {
        return Err("The ZIP archive cannot be saved inside the instance being exported".into());
    }

    let file = fs::File::create(&output_path).map_err(archive_error)?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let total_files = count_files(&source)?;
    let mut completed_files = 0;
    emit_archive_progress(app, task_id, 0, total_files);
    write_directory(
        &mut zip,
        &source,
        &source,
        options,
        app,
        task_id,
        &mut completed_files,
        total_files,
    )?;
    zip.finish().map_err(archive_error)?;
    Ok(())
}

fn count_files(current: &Path) -> Result<usize, String> {
    let mut count = 0;
    for entry in fs::read_dir(current)
        .map_err(archive_error)?
        .map(|entry| entry.map_err(archive_error))
    {
        let entry = entry?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(archive_error)?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            count += count_files(&entry.path())?;
        } else if metadata.is_file() {
            count += 1;
        }
    }
    Ok(count)
}

fn emit_archive_progress(app: &AppHandle, task_id: &str, completed: usize, total: usize) {
    let _ = app.emit(
        "install-progress",
        serde_json::json!({ "taskId": task_id, "message": format!("Files {completed}/{total}") }),
    );
}

fn write_directory(
    zip: &mut ZipWriter<fs::File>,
    root: &Path,
    current: &Path,
    options: SimpleFileOptions,
    app: &AppHandle,
    task_id: &str,
    completed_files: &mut usize,
    total_files: usize,
) -> Result<(), String> {
    let mut entries = fs::read_dir(current)
        .map_err(archive_error)?
        .map(|entry| entry.map_err(archive_error))
        .collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(archive_error)?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            write_directory(
                zip,
                root,
                &path,
                options,
                app,
                task_id,
                completed_files,
                total_files,
            )?;
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        let relative = path.strip_prefix(root).map_err(archive_error)?;
        let name = relative
            .components()
            .map(|part| part.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        zip.start_file(name, options).map_err(archive_error)?;
        let mut input = fs::File::open(path).map_err(archive_error)?;
        let mut buffer = [0; 64 * 1024];
        loop {
            let count = input.read(&mut buffer).map_err(archive_error)?;
            if count == 0 {
                break;
            }
            zip.write_all(&buffer[..count]).map_err(archive_error)?;
        }
        *completed_files += 1;
        if *completed_files % 5 == 0 || *completed_files == total_files {
            emit_archive_progress(app, task_id, *completed_files, total_files);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn remove_instances(req: RemoveInstancesReq) -> Result<Vec<Instance>, String> {
    if req.ids.is_empty() {
        return Err("Select at least one instance".into());
    }
    let root = crate::instance_root()?;
    let mut paths = Vec::with_capacity(req.ids.len());
    for id in &req.ids {
        if id.is_empty() || id.contains(['/', '\\']) || id == "." || id == ".." {
            return Err("Invalid instance ID".into());
        }
        let path = root.join(id);
        if instances::read_one(&path)?.is_none() {
            return Err(format!("Instance {id} was not found"));
        }
        paths.push(path);
    }

    let mut errors = Vec::new();
    for path in paths {
        if let Err(error) = fs::remove_dir_all(&path) {
            errors.push(format!("{}: {error}", path.display()));
        }
    }
    if !errors.is_empty() {
        return Err(format!(
            "Some instance folders could not be deleted:\n{}",
            errors.join("\n")
        ));
    }
    Ok(instances::scan_all(&root))
}

#[cfg(test)]
mod tests {
    use super::{
        archive_metadata_path, archive_single_root_prefix, safe_archive_path, validate_archive,
        MAX_EXTRACTED_BYTES,
    };
    use std::{
        io::{Cursor, Write},
        path::Path,
    };
    use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

    fn archive_with_files(files: &[(&str, &[u8])]) -> ZipArchive<Cursor<Vec<u8>>> {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, contents) in files {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(contents).unwrap();
        }
        ZipArchive::new(writer.finish().unwrap()).unwrap()
    }

    #[test]
    fn archive_paths_must_be_relative_and_traversal_free() {
        assert!(safe_archive_path(Path::new("saves/world/level.dat")));
        assert!(!safe_archive_path(Path::new("../outside.txt")));
        assert!(!safe_archive_path(Path::new("saves/../outside.txt")));
        assert!(!safe_archive_path(Path::new("")));
        assert!(!safe_archive_path(Path::new("/absolute/file")));
    }

    #[test]
    fn detects_metadata_and_nested_archive_roots() {
        let mut archive = archive_with_files(&[
            ("instances.json", br#"{"name":"Example"}"#),
            ("saves/world/level.dat", b"save"),
        ]);
        assert_eq!(
            archive_metadata_path(&mut archive).unwrap(),
            Some(String::new())
        );
        assert_eq!(archive_single_root_prefix(&mut archive).unwrap(), None);

        let mut nested = archive_with_files(&[
            ("Example/instances.json", br#"{"name":"Example"}"#),
            ("Example/saves/world/level.dat", b"save"),
        ]);
        assert_eq!(
            archive_metadata_path(&mut nested).unwrap(),
            Some("Example/".into())
        );
        assert_eq!(
            archive_single_root_prefix(&mut nested).unwrap(),
            Some("Example/".into())
        );
    }

    #[test]
    fn detects_missing_metadata_and_keeps_multiple_root_folders() {
        let mut archive = archive_with_files(&[
            ("mods/example.jar", b"mod"),
            ("saves/world/level.dat", b"save"),
        ]);
        assert_eq!(archive_metadata_path(&mut archive).unwrap(), None);
        assert_eq!(archive_single_root_prefix(&mut archive).unwrap(), None);
    }

    #[test]
    fn archive_validation_rejects_parent_directory_entries() {
        let mut archive = archive_with_files(&[("../outside.txt", b"no")]);
        assert!(validate_archive(&mut archive).is_err());
    }

    #[test]
    fn archive_import_has_a_bounded_expansion_limit() {
        assert_eq!(MAX_EXTRACTED_BYTES, 16 * 1024 * 1024 * 1024);
    }
}
