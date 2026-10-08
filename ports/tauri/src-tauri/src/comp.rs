use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::ffi::OsStr;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

// Format constants from docs/project-format.md. They describe the file format
// itself rather than user settings, so they live beside the parsing code that
// enforces them.
const PROJECT_FORMAT: &str = "com.compositor.project";
const MIN_VERSION: i64 = 1;
const MAX_VERSION: i64 = 11;
const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;
const MAX_ASSET_BYTES: u64 = 512 * 1024 * 1024;
const MAX_LAYERS: usize = 10_000;
const MAX_CANVAS_SIDE: f64 = 30_000.0;

#[derive(Serialize)]
pub struct ProjectSummary {
    name: String,
    path: String,
}

#[derive(Serialize)]
pub struct EncodedImage {
    file: String,
    base64: String,
}

#[derive(Serialize)]
pub struct LoadedProject {
    path: String,
    manifest: serde_json::Value,
    images: Vec<EncodedImage>,
}

#[tauri::command]
pub fn pick_folder(app: AppHandle, start: Option<String>) -> Option<String> {
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Choose a folder containing .comp projects");
    if let Some(directory) = start {
        dialog = dialog.set_directory(directory);
    }
    dialog.blocking_pick_folder().map(|path| path.to_string())
}

#[tauri::command]
pub fn list_projects(root: String) -> Result<Vec<ProjectSummary>, String> {
    let root = PathBuf::from(&root);
    let entries = fs::read_dir(&root)
        .map_err(|error| format!("Cannot read {}: {error}", root.display()))?;

    let mut projects = Vec::new();
    for entry in entries {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        let is_project = path
            .extension()
            .map(|ext| ext.eq_ignore_ascii_case("comp"))
            .unwrap_or(false)
            && path.join("manifest.json").is_file();
        if is_project {
            projects.push(ProjectSummary {
                name: path
                    .file_stem()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                path: path.to_string_lossy().into_owned(),
            });
        }
    }
    projects.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(projects)
}

#[tauri::command]
pub fn load_project(path: String) -> Result<LoadedProject, String> {
    let package = PathBuf::from(&path);
    let manifest_path = package.join("manifest.json");
    let metadata = fs::metadata(&manifest_path)
        .map_err(|_| format!("Not a Compositor project: {path}"))?;
    if metadata.len() > MAX_MANIFEST_BYTES {
        return Err("Manifest exceeds the 4 MiB limit".into());
    }

    let raw =
        fs::read_to_string(&manifest_path).map_err(|error| format!("Cannot read manifest: {error}"))?;
    let manifest: serde_json::Value =
        serde_json::from_str(&raw).map_err(|error| format!("Manifest is not valid JSON: {error}"))?;
    validate_manifest(&manifest)?;

    let mut files = Vec::<String>::new();
    if let Some(layers) = manifest["layers"].as_array() {
        for layer in layers {
            if let Some(file) = layer["imageFile"].as_str() {
                files.push(file.to_string());
            }
            if let Some(file) = layer["maskFile"].as_str() {
                files.push(file.to_string());
            }
        }
    }
    files.sort();
    files.dedup();

    let images_dir = package.join("images");
    let mut images = Vec::with_capacity(files.len());
    for file in files {
        let asset = images_dir.join(safe_asset_name(&file)?);
        let metadata = fs::metadata(&asset).map_err(|_| format!("Missing asset: {file}"))?;
        if metadata.len() > MAX_ASSET_BYTES {
            return Err(format!("Asset exceeds the 512 MiB limit: {file}"));
        }
        let bytes = fs::read(&asset).map_err(|error| format!("Cannot read asset {file}: {error}"))?;
        images.push(EncodedImage {
            file,
            base64: BASE64.encode(bytes),
        });
    }

    Ok(LoadedProject {
        path,
        manifest,
        images,
    })
}

#[tauri::command]
pub fn save_manifest(path: String, manifest: serde_json::Value) -> Result<(), String> {
    validate_manifest(&manifest)?;

    let package = PathBuf::from(&path);
    let manifest_path = package.join("manifest.json");
    let mut bytes =
        serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("Manifest exceeds the 4 MiB limit".into());
    }

    // Write beside the target and rename, mirroring the app's atomic save.
    let temp = package.join("manifest.json.tmp");
    fs::write(&temp, &bytes).map_err(|error| format!("Cannot write manifest: {error}"))?;
    fs::rename(&temp, &manifest_path)
        .map_err(|error| format!("Cannot replace manifest: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn export_png(
    app: AppHandle,
    file_name: String,
    base64_png: String,
) -> Result<Option<String>, String> {
    let dialog = app
        .dialog()
        .file()
        .add_filter("PNG image", &["png"])
        .set_file_name(&file_name);
    let Some(destination) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let bytes = BASE64
        .decode(base64_png.as_bytes())
        .map_err(|error| error.to_string())?;
    let destination = destination.to_string();
    fs::write(&destination, bytes).map_err(|error| format!("Cannot write PNG: {error}"))?;
    Ok(Some(destination))
}

fn validate_manifest(manifest: &serde_json::Value) -> Result<(), String> {
    if manifest["format"].as_str() != Some(PROJECT_FORMAT) {
        return Err("This is not a Compositor project manifest".into());
    }
    let version = manifest["version"]
        .as_i64()
        .ok_or("Manifest has no version")?;
    if !(MIN_VERSION..=MAX_VERSION).contains(&version) {
        return Err(format!(
            "Unsupported project version {version} (this port reads {MIN_VERSION}-{MAX_VERSION})"
        ));
    }
    let width = manifest["width"].as_f64().unwrap_or(0.0);
    let height = manifest["height"].as_f64().unwrap_or(0.0);
    if width < 1.0 || height < 1.0 || width > MAX_CANVAS_SIDE || height > MAX_CANVAS_SIDE {
        return Err("Canvas dimensions are outside the supported limits".into());
    }
    let layers = manifest["layers"]
        .as_array()
        .ok_or("Manifest has no layers array")?;
    if layers.len() > MAX_LAYERS {
        return Err("Project exceeds the 10,000 layer limit".into());
    }
    Ok(())
}

// Asset names must stay inside images/: a bare file name, no separators or traversal.
fn safe_asset_name(file: &str) -> Result<String, String> {
    let rejected = file.is_empty()
        || file.contains('/')
        || file.contains('\\')
        || file.contains("..")
        || Path::new(file).file_name() != Some(OsStr::new(file));
    if rejected {
        return Err(format!("Unsafe asset path: {file}"));
    }
    Ok(file.to_string())
}
