use serde::{Deserialize, Serialize};
use std::path::Path;

/// One saved account. Stored in launcher/config/accounts.json
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Stored {
    pub id: String,
    pub kind: String, // "offline" | "elyby" | "microsoft"
    pub username: String,
    pub uuid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_background: Option<String>,
    #[serde(default)]
    pub access_token: String, // Ely.by
    #[serde(default)]
    pub client_token: String, // Ely.by
    #[serde(default)]
    pub refresh_token: String, // Microsoft
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ms_client_id: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
pub struct Store {
    #[serde(default)]
    pub selected: Option<String>,
    #[serde(default)]
    pub accounts: Vec<Stored>,
}

pub fn load(dir: &Path) -> Result<Store, String> {
    let path = dir.join("accounts.json");
    let contents = match std::fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Store::default()),
        Err(error) => return Err(format!("Could not read {}: {error}", path.display())),
    };
    serde_json::from_str(&contents)
        .map_err(|error| format!("Could not parse {}: {error}", path.display()))
}

pub fn save(dir: &Path, s: &Store) -> Result<(), String> {
    let path = dir.join("accounts.json");
    let contents = serde_json::to_string_pretty(s)
        .map_err(|error| format!("Could not serialize accounts: {error}"))?;
    std::fs::write(&path, contents)
        .map_err(|error| format!("Could not save {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::{load, save, Store};
    use std::{fs, path::PathBuf};

    fn test_dir() -> PathBuf {
        std::env::temp_dir().join(format!("arca-accounts-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn missing_account_file_returns_empty_store() {
        let dir = test_dir();
        fs::create_dir_all(&dir).unwrap();
        assert!(load(&dir).unwrap().accounts.is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn malformed_account_file_returns_error() {
        let dir = test_dir();
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("accounts.json"), "{").unwrap();
        assert!(load(&dir).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn account_save_reports_write_errors() {
        let dir = test_dir();
        fs::create_dir_all(dir.join("accounts.json")).unwrap();
        assert!(save(&dir, &Store::default()).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
