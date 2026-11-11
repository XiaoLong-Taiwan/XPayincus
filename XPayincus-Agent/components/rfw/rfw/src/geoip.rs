use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Deserialize)]
struct Entry {
    country: String,
    fetched_at: u64,
    version: String,
    cidrs: Vec<String>,
}

fn validate(cidrs: &[String]) -> anyhow::Result<()> {
    anyhow::ensure!(!cidrs.is_empty() && cidrs.len() <= 65536, "Invalid GeoIP prefix count");
    anyhow::ensure!(cidrs.iter().all(|c| super::parse_cidr_to_lpm(c).is_some()), "GeoIP must contain valid IPv4 CIDRs only");
    Ok(())
}

pub async fn fetch(countries: &[String], directory: &Path, refresh: bool)
    -> anyhow::Result<(Vec<(String, Vec<String>)>, Vec<serde_json::Value>)> {
    anyhow::ensure!(countries.len() <= 32, "At most 32 countries per ruleset");
    std::fs::create_dir_all(directory)?;
    let mut data = Vec::new();
    let mut report = Vec::new();
    for country in countries {
        anyhow::ensure!(country.len() == 2 && country.bytes().all(|b| b.is_ascii_alphabetic()), "Invalid ISO country code");
        let country = country.to_ascii_uppercase();
        let path = directory.join(format!("{country}.json"));
        let now = super::unix_time();
        let cached = (|| -> anyhow::Result<Entry> {
            anyhow::ensure!(std::fs::metadata(&path)?.len() <= 8 * 1024 * 1024, "Oversized cache");
            let entry: Entry = serde_json::from_slice(&std::fs::read(&path)?)?;
            anyhow::ensure!(entry.country == country, "Cache country mismatch");
            validate(&entry.cidrs)?;
            Ok(entry)
        })().ok();
        let fresh = cached.as_ref().map(|c| now.saturating_sub(c.fetched_at) < 86400).unwrap_or(false);
        let mut source = "cache";
        let mut failure = None;
        let entry = if fresh && !refresh {
            cached.unwrap()
        } else {
            match super::fetch_geoip_data(&country).await.and_then(|cidrs| {
                validate(&cidrs)?;
                let mut fingerprint = 0xcbf29ce484222325u64;
                for byte in cidrs.join("\n").bytes() {
                    fingerprint = (fingerprint ^ u64::from(byte)).wrapping_mul(0x100000001b3);
                }
                Ok(Entry { country: country.clone(), fetched_at: now,
                    version: format!("fnv1a64:{fingerprint:016x}"), cidrs })
            }) {
                Ok(entry) => {
                    let bytes = serde_json::to_vec(&entry)?;
                    let total: u64 = std::fs::read_dir(directory)?.filter_map(Result::ok)
                        .filter_map(|e| e.metadata().ok()).map(|m| m.len()).sum();
                    let old_size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                    let update = (|| -> anyhow::Result<()> {
                        anyhow::ensure!(total.saturating_sub(old_size) + bytes.len() as u64 <= 64 * 1024 * 1024, "GeoIP cache limit 64 MiB reached");
                        super::atomic_write(&path, &bytes)?;
                        Ok(())
                    })();
                    match update {
                        Ok(()) => { source = "network"; entry }
                        Err(error) => {
                            failure = Some(error.to_string());
                            source = "last-success";
                            cached.context("Cache update failed without last successful data")?
                        }
                    }
                }
                Err(error) => {
                    failure = Some(error.to_string());
                    source = "last-success";
                    cached.with_context(|| format!("{country}: no last successful GeoIP data"))?
                }
            }
        };
        report.push(serde_json::json!({"country":country,"source":source,"version":entry.version,
            "fetchedAtUnix":entry.fetched_at,"prefixCount":entry.cidrs.len(),"error":failure,
            "addressFamily":"IPv4","versionAlgorithm":"FNV-1a content identifier, not authenticity proof"}));
        data.push((country, entry.cidrs));
    }
    Ok((data, report))
}
