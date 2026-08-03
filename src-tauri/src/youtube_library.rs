use crate::local_storage::LocalStorage;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::State;

const SCHEMA: u8 = 1;

struct Manifest {
    video_id: String,
    display_title: String,
    updated_at: String,
    versions: Vec<Version>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredManifest {
    schema_version: u8,
    video_id: String,
    display_title: String,
    updated_at: String,
    versions: Vec<StoredVersion>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredVersion {
    recipe_fingerprint: String,
    created_at: String,
    source_language: String,
    transcript_origin: String,
    exports: Vec<String>,
    segments: Vec<StoredSegment>,
    segments_sha256: String,
}
#[derive(Deserialize)]
struct StoredSegment {
    id: u32,
    start: Box<RawValue>,
    end: Box<RawValue>,
    text: Box<RawValue>,
}
#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Version {
    recipe_fingerprint: String,
    created_at: String,
    source_language: String,
    transcript_origin: String,
    exports: Vec<String>,
    segments: Vec<Segment>,
    segments_sha256: String,
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Export {
    path: String,
    available: bool,
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DetailVersion {
    recipe_fingerprint: String,
    created_at: String,
    source_language: String,
    transcript_origin: String,
    exports: Vec<Export>,
    segments: Vec<Segment>,
    segments_sha256: String,
}
#[derive(Deserialize, Serialize, Clone)]
struct Segment {
    id: u32,
    start: f64,
    end: f64,
    text: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    video_id: String,
    display_title: String,
    updated_at: String,
    version_count: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    video_id: String,
    display_title: String,
    updated_at: String,
    versions: Vec<DetailVersion>,
}

#[tauri::command]
pub fn list_youtube_library(storage: State<'_, LocalStorage>) -> Result<Vec<Summary>, String> {
    list_at(&storage.youtube_library_directory()?)
}
fn list_at(root: &Path) -> Result<Vec<Summary>, String> {
    let items = root.join("items");
    if items.exists()
        && fs::symlink_metadata(&items)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
    {
        return Err("YouTube library items path must not be a symlink".into());
    }
    if !items.exists() {
        return Ok(vec![]);
    }
    let mut results = vec![];
    for entry in fs::read_dir(&items).map_err(|e| format!("failed to read YouTube library: {e}"))? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if fs::symlink_metadata(&path)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("YouTube library item path must not be a symlink".into());
        }
        if !path.is_dir() {
            continue;
        }
        let video_id = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("invalid library item path")?;
        if !safe_id(video_id) {
            return Err("YouTube library contains an invalid item path".into());
        }
        let manifest = read_manifest(&path.join("manifest.json"), video_id)?;
        results.push(Summary {
            video_id: manifest.video_id,
            display_title: manifest.display_title,
            updated_at: manifest.updated_at,
            version_count: manifest.versions.len(),
        });
    }
    results.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(results)
}

#[tauri::command]
pub fn get_youtube_library_item(
    storage: State<'_, LocalStorage>,
    video_id: String,
) -> Result<Detail, String> {
    get_at(&storage.youtube_library_directory()?, &video_id)
}
fn get_at(root: &Path, video_id: &str) -> Result<Detail, String> {
    if !safe_id(&video_id) {
        return Err("invalid YouTube library item id".into());
    }
    let item = root.join("items").join(&video_id);
    if fs::symlink_metadata(&item)
        .map_err(|e| format!("library item is unavailable: {e}"))?
        .file_type()
        .is_symlink()
    {
        return Err("library item path must not be a symlink".into());
    }
    let manifest = read_manifest(&item.join("manifest.json"), &video_id)?;
    Ok(Detail {
        video_id: manifest.video_id,
        display_title: manifest.display_title,
        updated_at: manifest.updated_at,
        versions: manifest
            .versions
            .into_iter()
            .map(|version| DetailVersion {
                exports: version
                    .exports
                    .iter()
                    .map(|path| Export {
                        path: path.clone(),
                        available: Path::new(path).is_file(),
                    })
                    .collect(),
                recipe_fingerprint: version.recipe_fingerprint,
                created_at: version.created_at,
                source_language: version.source_language,
                transcript_origin: version.transcript_origin,
                segments: version.segments,
                segments_sha256: version.segments_sha256,
            })
            .collect(),
    })
}

#[tauri::command]
pub fn delete_youtube_library_item(
    storage: State<'_, LocalStorage>,
    video_id: String,
) -> Result<(), String> {
    delete_at(&storage.youtube_library_directory()?, &video_id)
}
fn delete_at(root: &Path, video_id: &str) -> Result<(), String> {
    if !safe_id(&video_id) {
        return Err("invalid YouTube library item id".into());
    }
    let item = root.join("items").join(&video_id);
    if fs::symlink_metadata(&item)
        .map_err(|e| format!("library item is unavailable: {e}"))?
        .file_type()
        .is_symlink()
    {
        return Err("library item path must not be a symlink".into());
    }
    read_manifest(&item.join("manifest.json"), &video_id)?;
    fs::remove_dir_all(&item).map_err(|e| format!("failed to remove YouTube library item: {e}"))
}

fn read_manifest(path: &Path, expected_id: &str) -> Result<Manifest, String> {
    if fs::symlink_metadata(path)
        .map_err(|e| format!("library item is unavailable: {e}"))?
        .file_type()
        .is_symlink()
    {
        return Err("library item path must not be a symlink".into());
    }
    let bytes = fs::read(path).map_err(|e| format!("library item is unavailable: {e}"))?;
    let stored: StoredManifest =
        serde_json::from_slice(&bytes).map_err(|_| "library item is corrupt".to_string())?;
    if stored.schema_version != SCHEMA
        || stored.video_id != expected_id
        || !safe_id(&stored.video_id)
        || stored.display_title.is_empty()
        || stored.display_title.chars().count() > 80
        || stored.versions.is_empty()
    {
        return Err("library item is corrupt".into());
    }
    let versions = stored
        .versions
        .into_iter()
        .map(validate_version)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Manifest {
        video_id: stored.video_id,
        display_title: stored.display_title,
        updated_at: stored.updated_at,
        versions,
    })
}
fn validate_version(stored: StoredVersion) -> Result<Version, String> {
    if !lower_hex(&stored.recipe_fingerprint)
        || !lower_hex(&stored.segments_sha256)
        || !matches!(stored.source_language.as_str(), "en" | "vi")
        || !matches!(
            stored.transcript_origin.as_str(),
            "manual_caption"
                | "automatic_caption"
                | "whisper_transcribe"
                | "whisper_translate_to_english"
        )
        || stored.segments.is_empty()
        || stored
            .exports
            .iter()
            .any(|path| !PathBuf::from(path).is_absolute())
    {
        return Err("library item is corrupt".into());
    }
    let mut hasher = Sha256::new();
    hasher.update(b"[");
    let mut segments = Vec::with_capacity(stored.segments.len());
    for (index, stored_segment) in stored.segments.into_iter().enumerate() {
        let start: f64 = serde_json::from_str(stored_segment.start.get())
            .map_err(|_| "library item is corrupt")?;
        let end: f64 = serde_json::from_str(stored_segment.end.get())
            .map_err(|_| "library item is corrupt")?;
        let text: String = serde_json::from_str(stored_segment.text.get())
            .map_err(|_| "library item is corrupt")?;
        if stored_segment.id as usize != index
            || !start.is_finite()
            || !end.is_finite()
            || start < 0.0
            || end <= start
            || text.trim().is_empty()
        {
            return Err("library item is corrupt".into());
        }
        if index > 0 {
            hasher.update(b",");
        }
        hasher.update(b"{\"id\":");
        hasher.update(stored_segment.id.to_string().as_bytes());
        hasher.update(b",\"start\":");
        update_python_float_hash(&mut hasher, stored_segment.start.get());
        hasher.update(b",\"end\":");
        update_python_float_hash(&mut hasher, stored_segment.end.get());
        hasher.update(b",\"text\":");
        hasher.update(stored_segment.text.get().as_bytes());
        hasher.update(b"}");
        segments.push(Segment {
            id: stored_segment.id,
            start,
            end,
            text,
        });
    }
    hasher.update(b"]");
    if format!("{:x}", hasher.finalize()) != stored.segments_sha256 {
        return Err("library transcript hash is invalid".into());
    }
    Ok(Version {
        recipe_fingerprint: stored.recipe_fingerprint,
        created_at: stored.created_at,
        source_language: stored.source_language,
        transcript_origin: stored.transcript_origin,
        exports: stored.exports,
        segments,
        segments_sha256: stored.segments_sha256,
    })
}
fn update_python_float_hash(hasher: &mut Sha256, raw: &str) {
    hasher.update(raw.as_bytes());
    if !raw.contains(['.', 'e', 'E']) {
        hasher.update(b".0");
    }
}
fn lower_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn safe_id(value: &str) -> bool {
    (6..=32).contains(&value.len())
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

#[cfg(test)]
mod tests {
    use super::{delete_at, get_at, list_at, read_manifest, safe_id, Segment};
    use serde_json::json;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn rejects_path_traversal_ids() {
        assert!(!safe_id("../youtube-cache"));
        assert!(!safe_id("abc/def"));
        assert!(safe_id("abc123def45"));
    }

    #[test]
    fn corrupt_manifest_fails_closed() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("whispersub-library-{nonce}.json"));
        fs::write(&path, b"{not-json").unwrap();
        assert!(read_manifest(&path, "abc123def45").is_err());
        fs::remove_file(path).ok();
    }

    fn fixture() -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "whispersub-library-test-{}-{nonce}",
            std::process::id()
        ))
    }
    fn write_valid(
        root: &std::path::Path,
        id: &str,
        export: &std::path::Path,
    ) -> std::path::PathBuf {
        let segments = vec![Segment {
            id: 0,
            start: 0.0,
            end: 1.0,
            text: "Xin chào".into(),
        }];
        // This literal is the SHA-256 of Python _encode_segments output:
        // [{"id":0,"start":0.0,"end":1.0,"text":"Xin chào"}]
        let digest = "24c9a39b6cc1ed1335c12a171ae9fd489620c4e1eb37f346652790ebe3eb0616";
        let path = root.join("items").join(id).join("manifest.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, serde_json::to_vec(&json!({"schemaVersion":1,"videoId":id,"displayTitle":"Bai hoc","updatedAt":"2026-01-01T00:00:00Z","versions":[{"recipeFingerprint":"a".repeat(64),"createdAt":"2026-01-01T00:00:00Z","sourceLanguage":"vi","transcriptOrigin":"manual_caption","exports":[export],"segments":segments,"segmentsSha256":digest}]})).unwrap()).unwrap();
        path
    }
    #[test]
    fn validates_display_title_length_by_unicode_characters() {
        let root = fixture();
        let export = root.join("external.srt");
        let path = write_valid(&root, "abc123def45", &export);
        let mut doc: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();

        doc["displayTitle"] = json!("界".repeat(80));
        fs::write(&path, serde_json::to_vec(&doc).unwrap()).unwrap();
        assert!(get_at(&root, "abc123def45").is_ok());

        doc["displayTitle"] = json!("界".repeat(81));
        fs::write(&path, serde_json::to_vec(&doc).unwrap()).unwrap();
        let error = match get_at(&root, "abc123def45") {
            Ok(_) => panic!("81-character display title must be rejected"),
            Err(error) => error,
        };
        assert_eq!(error, "library item is corrupt");

        fs::remove_dir_all(root).ok();
    }
    #[test]
    fn validates_python_float_lexemes_without_lossy_reserialization() {
        let root = fixture();
        let export = root.join("external.srt");
        let path = root.join("items/abc123def45/manifest.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let digest = "41e94962a5af2cf777b5606ce34896cba504919a08acbf6f6dbfdd91bb39e6ee";
        let manifest = format!(
            r#"{{"displayTitle":"Bai hoc","schemaVersion":1,"updatedAt":"2026-01-01T00:00:00Z","versions":[{{"createdAt":"2026-01-01T00:00:00Z","exports":["{}"],"recipeFingerprint":"{}","segments":[{{"end":35.519999999999996,"id":0,"start":29.599999999999998,"text":"Xin chào"}}],"segmentsSha256":"{digest}","sourceLanguage":"vi","transcriptOrigin":"manual_caption"}}],"videoId":"abc123def45"}}"#,
            export.to_string_lossy(),
            "a".repeat(64),
        );
        fs::write(&path, manifest).unwrap();

        assert!(get_at(&root, "abc123def45").is_ok());

        fs::remove_dir_all(root).ok();
    }
    #[test]
    fn normalizes_integer_timestamp_tokens_like_python_float() {
        let root = fixture();
        let export = root.join("external.srt");
        let path = root.join("items/abc123def45/manifest.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let digest = "24c9a39b6cc1ed1335c12a171ae9fd489620c4e1eb37f346652790ebe3eb0616";
        let manifest = format!(
            r#"{{"displayTitle":"Bai hoc","schemaVersion":1,"updatedAt":"2026-01-01T00:00:00Z","versions":[{{"createdAt":"2026-01-01T00:00:00Z","exports":["{}"],"recipeFingerprint":"{}","segments":[{{"end":1,"id":0,"start":0,"text":"Xin chào"}}],"segmentsSha256":"{digest}","sourceLanguage":"vi","transcriptOrigin":"manual_caption"}}],"videoId":"abc123def45"}}"#,
            export.to_string_lossy(),
            "a".repeat(64),
        );
        fs::write(&path, manifest).unwrap();

        assert!(get_at(&root, "abc123def45").is_ok());

        fs::remove_dir_all(root).ok();
    }
    #[test]
    fn rejects_hash_fingerprint_and_enum_corruption() {
        let root = fixture();
        fs::create_dir_all(&root).unwrap();
        let export = root.join("external.srt");
        fs::write(&export, "x").unwrap();
        let path = write_valid(&root, "abc123def45", &export);
        let cases = [
            ("segmentsSha256", json!("b".repeat(64))),
            ("recipeFingerprint", json!("BAD")),
            ("sourceLanguage", json!("fr")),
            ("transcriptOrigin", json!("unknown")),
        ];
        for (field, value) in cases {
            let mut doc: serde_json::Value =
                serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            doc["versions"][0][field] = value;
            fs::write(&path, serde_json::to_vec(&doc).unwrap()).unwrap();
            assert!(get_at(&root, "abc123def45").is_err(), "{field}");
            fs::write(
                &path,
                serde_json::to_vec(
                    &serde_json::from_slice::<serde_json::Value>(&fs::read(&path).unwrap())
                        .unwrap(),
                )
                .unwrap(),
            )
            .unwrap();
            write_valid(&root, "abc123def45", &export);
        }
        fs::remove_dir_all(root).ok();
    }
    #[test]
    fn delete_isolated_from_cache_and_external_export_and_fails_closed() {
        let root = fixture();
        let cache = root
            .parent()
            .unwrap()
            .join(format!("youtube-cache-{}", std::process::id()));
        fs::create_dir_all(&cache).unwrap();
        fs::write(cache.join("keep"), "cache").unwrap();
        let export = root
            .parent()
            .unwrap()
            .join(format!("outside-{}.srt", std::process::id()));
        fs::write(&export, "subtitle").unwrap();
        write_valid(&root, "abc123def45", &export);
        delete_at(&root, "abc123def45").unwrap();
        assert!(cache.join("keep").exists());
        assert!(export.exists());
        assert!(delete_at(&root, "abc123def45").is_err());
        let corrupt = root.join("items/abc123def46/manifest.json");
        fs::create_dir_all(corrupt.parent().unwrap()).unwrap();
        fs::write(&corrupt, b"{").unwrap();
        assert!(get_at(&root, "abc123def46").is_err());
        assert!(delete_at(&root, "abc123def46").is_err());
        assert!(corrupt.exists());
        fs::remove_dir_all(root).ok();
        fs::remove_dir_all(cache).ok();
        fs::remove_file(export).ok();
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_item_or_manifest() {
        use std::os::unix::fs::symlink;
        let root = fixture();
        let external = fixture();
        fs::create_dir_all(external.join("abc123def45")).unwrap();
        symlink(external.join("abc123def45"), root.join("items/abc123def45")).unwrap_or_else(
            |_| {
                fs::create_dir_all(root.join("items")).unwrap();
                symlink(external.join("abc123def45"), root.join("items/abc123def45")).unwrap()
            },
        );
        assert!(list_at(&root).is_err());
        fs::remove_dir_all(root).ok();
        fs::remove_dir_all(external).ok();
    }
}
