use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// A ready-to-launch account (runtime only, never saved as-is).
#[derive(Clone)]
pub struct Account {
    pub username: String,
    pub uuid: String,
    pub token: String,
    pub user_type: String,
    pub jvm: Vec<String>,
}

// ------------------------------------------------------------ offline

/// Same UUID vanilla servers use: MD5("OfflinePlayer:<name>") with version-3 bits.
pub fn offline(name: &str) -> Account {
    let mut h = md5::compute(format!("OfflinePlayer:{name}")).0;
    h[6] = (h[6] & 0x0f) | 0x30;
    h[8] = (h[8] & 0x3f) | 0x80;
    Account {
        username: name.into(),
        uuid: uuid::Uuid::from_bytes(h).simple().to_string(),
        token: "0".into(),
        user_type: "legacy".into(),
        jvm: vec![],
    }
}

// ------------------------------------------------------------ Ely.by

const ELY: &str = "https://authserver.ely.by/auth";

async fn injector(dir: &Path) -> Result<PathBuf> {
    let jar = dir.join("authlib-injector.jar");
    if !jar.exists() {
        let c = reqwest::Client::new();
        let info: Value = c
            .get("https://authlib-injector.yushi.moe/artifact/latest.json")
            .send()
            .await?
            .json()
            .await?;
        let url = info["download_url"]
            .as_str()
            .ok_or_else(|| anyhow!("authlib-injector url missing"))?;
        std::fs::write(
            &jar,
            c.get(url).send().await?.error_for_status()?.bytes().await?,
        )?;
    }
    Ok(jar)
}

/// Password login (used once, when adding the account).
pub async fn ely_login(dir: &Path, user: &str, pass: &str, client_token: &str) -> Result<Account> {
    let c = reqwest::Client::new();
    let r = c
        .post(format!("{ELY}/authenticate"))
        .json(&json!({"username": user, "password": pass, "clientToken": client_token, "requestUser": true}))
        .send()
        .await?;
    let ok = r.status().is_success();
    let v: Value = r.json().await?;
    if !ok {
        return Err(anyhow!(v["errorMessage"]
            .as_str()
            .unwrap_or("Ely.by login failed")
            .to_string()));
    }
    let p = &v["selectedProfile"];
    let jar = injector(dir).await?;
    Ok(Account {
        username: p["name"]
            .as_str()
            .ok_or_else(|| anyhow!("No Ely.by profile on this account"))?
            .into(),
        uuid: p["id"].as_str().unwrap_or_default().into(),
        token: v["accessToken"].as_str().unwrap_or_default().into(),
        user_type: "mojang".into(),
        jvm: vec![format!("-javaagent:{}=ely.by", jar.display())],
    })
}

/// Reuse a saved token; refresh it if it expired.
pub async fn ely_session(
    dir: &Path,
    name: &str,
    uuid: &str,
    access: &str,
    client_token: &str,
) -> Result<Account> {
    let c = reqwest::Client::new();
    let mut token = access.to_string();
    let valid = c
        .post(format!("{ELY}/validate"))
        .json(&json!({"accessToken": token}))
        .send()
        .await?
        .status()
        .is_success();
    if !valid {
        let r = c
            .post(format!("{ELY}/refresh"))
            .json(&json!({"accessToken": token, "clientToken": client_token}))
            .send()
            .await?;
        let ok = r.status().is_success();
        let v: Value = r.json().await?;
        if !ok {
            return Err(anyhow!(
                "Ely.by session expired. Remove the account and add it again."
            ));
        }
        token = v["accessToken"]
            .as_str()
            .ok_or_else(|| anyhow!("Ely.by refresh failed"))?
            .to_string();
    }
    let jar = injector(dir).await?;
    Ok(Account {
        username: name.into(),
        uuid: uuid.into(),
        token,
        user_type: "mojang".into(),
        jvm: vec![format!("-javaagent:{}=ely.by", jar.display())],
    })
}

// ------------------------------------------------------------ Microsoft

const TENANT: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
const SCOPE: &str = "XboxLive.signin offline_access";

fn tokens(v: &Value) -> Result<(String, String)> {
    let a = v["access_token"].as_str().ok_or_else(|| {
        anyhow!(v["error_description"]
            .as_str()
            .unwrap_or("Microsoft login failed")
            .to_string())
    })?;
    Ok((a.into(), v["refresh_token"].as_str().unwrap_or("").into()))
}

/// New account: device-code login. Returns the account and its refresh token.
pub async fn ms_new(app: &AppHandle, client_id: &str) -> Result<(Account, String)> {
    let c = reqwest::Client::new();
    let d: Value = c
        .post(format!("{TENANT}/devicecode"))
        .form(&[("client_id", client_id), ("scope", SCOPE)])
        .send()
        .await?
        .json()
        .await?;
    let code = d["user_code"].as_str().ok_or_else(|| {
        anyhow!(d["error_description"]
            .as_str()
            .unwrap_or("Device code request failed")
            .to_string())
    })?;
    let url = d["verification_uri"]
        .as_str()
        .unwrap_or("https://microsoft.com/link");
    let device = d["device_code"].as_str().unwrap_or_default();
    let mut interval = d["interval"].as_u64().unwrap_or(5);
    let _ = app.emit("ms-code", json!({"code": code, "url": url}));
    let _ = webbrowser::open(url);
    let (access, refresh) = loop {
        tokio::time::sleep(Duration::from_secs(interval)).await;
        let v: Value = c
            .post(format!("{TENANT}/token"))
            .form(&[
                ("client_id", client_id),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("device_code", device),
            ])
            .send()
            .await?
            .json()
            .await?;
        if v["access_token"].is_string() {
            break tokens(&v)?;
        }
        match v["error"].as_str() {
            Some("authorization_pending") => {}
            Some("slow_down") => interval += 5,
            _ => {
                return Err(anyhow!(v["error_description"]
                    .as_str()
                    .unwrap_or("Microsoft login failed")
                    .to_string()))
            }
        }
    };
    Ok((ms_finish(&c, &access).await?, refresh))
}

/// Existing account: silent login with the saved refresh token.
pub async fn ms_resume(client_id: &str, refresh: &str) -> Result<(Account, String)> {
    let c = reqwest::Client::new();
    let v: Value = c
        .post(format!("{TENANT}/token"))
        .form(&[
            ("client_id", client_id),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh),
            ("scope", SCOPE),
        ])
        .send()
        .await?
        .json()
        .await?;
    let (access, new_refresh) = tokens(&v)
        .map_err(|_| anyhow!("Microsoft session expired. Remove the account and add it again."))?;
    let rt = if new_refresh.is_empty() {
        refresh.to_string()
    } else {
        new_refresh
    };
    Ok((ms_finish(&c, &access).await?, rt))
}

/// Xbox Live -> XSTS -> Minecraft services -> profile
async fn ms_finish(c: &reqwest::Client, ms_access: &str) -> Result<Account> {
    let xbl: Value = c
        .post("https://user.auth.xboxlive.com/user/authenticate")
        .json(&json!({"Properties": {"AuthMethod": "RPS", "SiteName": "user.auth.xboxlive.com", "RpsTicket": format!("d={ms_access}")},
                      "RelyingParty": "http://auth.xboxlive.com", "TokenType": "JWT"}))
        .send().await?.json().await?;
    let xbl_token = xbl["Token"]
        .as_str()
        .ok_or_else(|| anyhow!("Xbox Live authentication failed"))?;
    let uhs = xbl["DisplayClaims"]["xui"][0]["uhs"]
        .as_str()
        .ok_or_else(|| anyhow!("Missing Xbox user hash"))?;

    let xsts: Value = c
        .post("https://xsts.auth.xboxlive.com/xsts/authorize")
        .json(
            &json!({"Properties": {"SandboxId": "RETAIL", "UserTokens": [xbl_token]},
                      "RelyingParty": "rp://api.minecraftservices.com/", "TokenType": "JWT"}),
        )
        .send()
        .await?
        .json()
        .await?;
    let xsts_token = xsts["Token"].as_str().ok_or_else(|| anyhow!("XSTS failed (Xbox error {}). The account may lack an Xbox profile or be a child account.", xsts["XErr"]))?;

    let mc: Value = c
        .post("https://api.minecraftservices.com/authentication/login_with_xbox")
        .json(&json!({"identityToken": format!("XBL3.0 x={uhs};{xsts_token}")}))
        .send()
        .await?
        .json()
        .await?;
    let mc_token = mc["access_token"]
        .as_str()
        .ok_or_else(|| anyhow!("Minecraft login failed"))?;

    let r = c
        .get("https://api.minecraftservices.com/minecraft/profile")
        .bearer_auth(mc_token)
        .send()
        .await?;
    if !r.status().is_success() {
        return Err(anyhow!(
            "This Microsoft account doesn't own Minecraft: Java Edition"
        ));
    }
    let p: Value = r.json().await?;
    Ok(Account {
        username: p["name"].as_str().unwrap_or_default().into(),
        uuid: p["id"].as_str().unwrap_or_default().into(),
        token: mc_token.into(),
        user_type: "msa".into(),
        jvm: vec![],
    })
}
