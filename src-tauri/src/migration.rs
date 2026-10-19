//! One-time migration from the old central `launcher/config/instances.json` registry to the
//! new layout, where each instance folder carries its own `instances.json`.
use crate::instances::{self, Instance};
use serde::Deserialize;
use tauri::{AppHandle, Emitter};

/// The old central registry's per-entry shape. Used only while migrating.
#[derive(Deserialize)]
struct LegacyInstance {
    id: String,
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

const TASK_ID: &str = "legacy-migration";

fn emit_progress(app: &AppHandle, message: impl Into<String>) {
    let message = message.into();
    let _ = app.emit(
        "install-progress",
        serde_json::json!({ "taskId": TASK_ID, "message": message }),
    );
}

/// True if an old-style central registry is still on disk and needs migrating. Cheap - safe to
/// call on every startup.
#[tauri::command]
pub fn legacy_migration_pending() -> bool {
    let (_, _, cfg) = crate::setup_dirs();
    cfg.join("instances.json").is_file()
}

/// Migrates every instance named in the old registry into its own folder's instances.json,
/// verifies each one by reading it back, and only then deletes the old registry. If anything
/// with an existing folder fails to migrate, the old registry is left in place so this retries
/// cleanly on the next launch instead of silently losing data.
#[tauri::command]
pub async fn migrate_legacy_instances(app: AppHandle) -> Result<(), String> {
    let (_, _, cfg) = crate::setup_dirs();
    let legacy_path = cfg.join("instances.json");
    let contents = match std::fs::read_to_string(&legacy_path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Could not read the old instance list: {error}")),
    };
    let legacy: Vec<LegacyInstance> = serde_json::from_str(&contents)
        .map_err(|e| format!("Could not parse the old instance list: {e}"))?;

    let instance_root = crate::instance_root()?;
    let total = legacy.len();
    if total > 0 {
        emit_progress(
            &app,
            format!("Migrating {total} instance(s) to the new format..."),
        );
    }

    let mut migrated = 0usize;
    let mut skipped = 0usize;
    for (index, old) in legacy.iter().enumerate() {
        let dir = instance_root.join(&old.id);
        if !dir.is_dir() {
            skipped += 1;
            emit_progress(
                &app,
                format!(
                    "Skipped {} - folder not found ({}/{total})",
                    old.name,
                    index + 1
                ),
            );
            continue;
        }

        let instance = Instance {
            id: old.id.clone(),
            name: old.name.clone(),
            loader: old.loader.clone(),
            mc: old.mc.clone(),
            version_id: old.version_id.clone(),
            icon: old.icon.clone(),
            description: old.description.clone(),
            background: old.background.clone(),
        };
        instances::write_one(&dir, &instance)
            .map_err(|e| format!("Could not migrate {}: {e}", old.name))?;

        // Verify: read back exactly what was just written before trusting it.
        let verified = instances::read_one(&dir)
            .map_err(|e| format!("Could not verify migrated instance {}: {e}", old.name))?
            .ok_or_else(|| {
                format!(
                    "Could not verify migrated instance {}: file missing after write",
                    old.name
                )
            })?;
        let matches = verified.name == instance.name
            && verified.loader == instance.loader
            && verified.mc == instance.mc
            && verified.version_id == instance.version_id
            && verified.icon == instance.icon
            && verified.description == instance.description
            && verified.background == instance.background;
        if !matches {
            return Err(format!(
                "Verification failed for migrated instance {}",
                old.name
            ));
        }

        migrated += 1;
        emit_progress(
            &app,
            format!("Migrated {} ({}/{total})", old.name, index + 1),
        );
    }

    // Only now - once every entry that actually had a folder is confirmed migrated - is it
    // safe to remove the old registry. Any earlier error already returned above, leaving this
    // file in place so migration retries cleanly on the next launch.
    std::fs::remove_file(&legacy_path).map_err(|e| {
        format!("Instances were migrated, but the old registry file could not be removed: {e}")
    })?;
    emit_progress(
        &app,
        format!("Migration complete: {migrated} migrated, {skipped} skipped"),
    );
    Ok(())
}
