use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
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

#[derive(Deserialize)]
pub struct ProjectAsset {
    file: String,
    base64: String,
}

#[derive(Serialize)]
pub struct ImportedImage {
    name: String,
    base64: String,
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

// Save As: only picks the destination; the frontend saves to it through
// save_project. Mirrors the Electron port's pick_save_path.
#[tauri::command]
pub fn pick_save_path(app: AppHandle, file_name: Option<String>) -> Option<String> {
    let dialog = app
        .dialog()
        .file()
        .set_title("Save Compositor Project")
        .add_filter("Compositor project", &["comp"]);
    let dialog = match file_name {
        Some(name) => dialog.set_file_name(&name),
        None => dialog,
    };
    dialog.blocking_save_file().map(|path| path.to_string())
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

// Saves the manifest plus every asset touched since the last save in one call,
// mirroring the macOS ProjectStore's atomic save flow. Unsaved projects may pass
// a package path that does not exist yet.
#[tauri::command]
pub fn save_project(
    path: String,
    manifest: serde_json::Value,
    images: Vec<ProjectAsset>,
) -> Result<(), String> {
    validate_manifest(&manifest)?;

    let package = PathBuf::from(&path);
    fs::create_dir_all(&package).map_err(|error| format!("Cannot create {}: {error}", package.display()))?;
    let images_dir = package.join("images");
    fs::create_dir_all(&images_dir)
        .map_err(|error| format!("Cannot create {}: {error}", images_dir.display()))?;

    let mut bytes = serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("Manifest exceeds the 4 MiB limit".into());
    }
    // Write beside the target and rename, mirroring the app's atomic save.
    let temp = package.join("manifest.json.tmp");
    fs::write(&temp, &bytes).map_err(|error| format!("Cannot write manifest: {error}"))?;
    fs::rename(&temp, package.join("manifest.json"))
        .map_err(|error| format!("Cannot replace manifest: {error}"))?;

    for asset in images {
        let name = safe_asset_name(&asset.file)?;
        let bytes = BASE64
            .decode(asset.base64.as_bytes())
            .map_err(|error| format!("Cannot decode asset {name}: {error}"))?;
        if bytes.len() as u64 > MAX_ASSET_BYTES {
            return Err(format!("Asset exceeds the 512 MiB limit: {name}"));
        }
        let temp = images_dir.join(format!("{name}.tmp"));
        fs::write(&temp, &bytes).map_err(|error| format!("Cannot write asset {name}: {error}"))?;
        fs::rename(&temp, images_dir.join(&name))
            .map_err(|error| format!("Cannot replace asset {name}: {error}"))?;
    }
    Ok(())
}

// Exports a rendered PNG or JPEG with the document resolution embedded as DPI
// metadata, matching the macOS exporter (kCGImagePropertyDPIWidth/Height).
// The frontend flattens JPEGs onto their background and encodes at the chosen
// quality; this side only stamps the metadata and writes the file.
#[tauri::command]
pub fn export_file(
    app: AppHandle,
    file_name: String,
    base64: String,
    kind: String,
    quality: f64,
    ppi: f64,
) -> Result<Option<String>, String> {
    let bytes = BASE64
        .decode(base64.as_bytes())
        .map_err(|error| error.to_string())?;
    // Quality is baked into the frontend's encode; kept in the signature for
    // call-site parity with the macOS exporter's JPEGOptions.
    let _ = quality;
    let bytes = match kind.as_str() {
        "jpeg" => Ok(set_jpeg_density(bytes, ppi)),
        _ => set_png_resolution(bytes, ppi),
    }?;
    let (filter, extensions) = if kind == "jpeg" {
        ("JPEG image", &["jpg", "jpeg"][..])
    } else {
        ("PNG image", &["png"][..])
    };
    let dialog = app
        .dialog()
        .file()
        .add_filter(filter, extensions)
        .set_file_name(&file_name);
    let Some(destination) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let destination = destination.to_string();
    fs::write(&destination, bytes).map_err(|error| format!("Cannot write {kind}: {error}"))?;
    Ok(Some(destination))
}

// Picks image files for placement (ImageImporter parity: PNG/JPEG, plus types the
// OS codec supports such as TIFF, HEIC and WebP) and returns them as base64.
#[tauri::command]
pub fn import_images(app: AppHandle) -> Result<Vec<ImportedImage>, String> {
    let dialog = app.dialog().file().add_filter(
        "Images",
        &["png", "jpg", "jpeg", "tif", "tiff", "heic", "heif", "webp", "bmp", "gif"],
    );
    let Some(paths) = dialog.blocking_pick_files() else {
        return Ok(Vec::new());
    };
    let mut images = Vec::with_capacity(paths.len());
    for path in paths {
        let path = path.to_string();
        let bytes = fs::read(&path).map_err(|error| format!("Cannot read {path}: {error}"))?;
        if bytes.len() as u64 > MAX_ASSET_BYTES {
            return Err(format!("Asset exceeds the 512 MiB limit: {path}"));
        }
        let name = Path::new(&path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "image".into());
        images.push(ImportedImage {
            name,
            base64: BASE64.encode(bytes),
        });
    }
    Ok(images)
}

fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (index, entry) in table.iter_mut().enumerate() {
        let mut value = index as u32;
        for _ in 0..8 {
            value = if value & 1 != 0 { 0xEDB8_8320 ^ (value >> 1) } else { value >> 1 };
        }
        *entry = value;
    }
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in data {
        crc = table[((crc ^ byte as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
// Signature + IHDR chunk: 8 + (4 length + 4 type + 13 data + 4 CRC).
const PNG_IHDR_END: usize = 33;

// Embeds the resolution as a pHYs chunk (pixels per metre) right after IHDR,
// replacing any existing one. Equivalent to ImageIO's kCGImagePropertyDPIWidth.
fn set_png_resolution(png: Vec<u8>, ppi: f64) -> Result<Vec<u8>, String> {
    if png.len() < PNG_IHDR_END
        || &png[0..8] != PNG_SIGNATURE
        || &png[12..16] != b"IHDR"
    {
        return Err("Export is not a valid PNG".into());
    }
    let metres = (ppi / 0.0254).round().max(1.0) as u32;
    let mut chunk = Vec::with_capacity(21);
    chunk.extend_from_slice(&9u32.to_be_bytes());
    chunk.extend_from_slice(b"pHYs");
    chunk.extend_from_slice(&metres.to_be_bytes());
    chunk.extend_from_slice(&metres.to_be_bytes());
    chunk.push(1); // unit: metre
    let crc = crc32(&chunk[4..]);
    chunk.extend_from_slice(&crc.to_be_bytes());

    let mut out = Vec::with_capacity(png.len() + 21);
    out.extend_from_slice(&png[..PNG_IHDR_END]);
    out.extend_from_slice(&chunk);
    let mut offset = PNG_IHDR_END;
    while offset + 8 <= png.len() {
        let length = u32::from_be_bytes([png[offset], png[offset + 1], png[offset + 2], png[offset + 3]]) as usize;
        let end = offset + 8 + length + 4;
        if end > png.len() {
            return Err("Export is not a valid PNG".into());
        }
        if &png[offset + 4..offset + 8] != b"pHYs" {
            out.extend_from_slice(&png[offset..end]);
        }
        offset = end;
    }
    Ok(out)
}

// Patches the JFIF APP0 density fields to the document resolution in DPI.
// If the encoder wrote no JFIF segment the data passes through unchanged.
fn set_jpeg_density(mut jpeg: Vec<u8>, ppi: f64) -> Vec<u8> {
    if jpeg.len() >= 18
        && jpeg[0] == 0xFF && jpeg[1] == 0xD8
        && jpeg[2] == 0xFF && jpeg[3] == 0xE0
        && jpeg[6..11] == *b"JFIF\x00"
    {
        jpeg[13] = 1; // density unit: dots per inch
        let density = ppi.round().clamp(1.0, 65535.0) as u16;
        jpeg[14..16].copy_from_slice(&density.to_be_bytes());
        jpeg[16..18].copy_from_slice(&density.to_be_bytes());
    }
    jpeg
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_png() -> Vec<u8> {
        let mut png = Vec::new();
        png.extend_from_slice(PNG_SIGNATURE);
        // IHDR: length 13, type, 13 data bytes, CRC (not verified by the stamper).
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&[0u8; 13]);
        png.extend_from_slice(&[0u8; 4]);
        // An existing pHYs the stamper must replace.
        png.extend_from_slice(&9u32.to_be_bytes());
        png.extend_from_slice(b"pHYs");
        png.extend_from_slice(&[0u8; 9]);
        png.extend_from_slice(&[0u8; 4]);
        // IDAT (empty) + IEND.
        png.extend_from_slice(&0u32.to_be_bytes());
        png.extend_from_slice(b"IDAT");
        png.extend_from_slice(&[0u8; 4]);
        png.extend_from_slice(&0u32.to_be_bytes());
        png.extend_from_slice(b"IEND");
        png.extend_from_slice(&[0u8; 4]);
        png
    }

    #[test]
    fn png_resolution_stamps_pHYs_and_replaces_existing() {
        let out = set_png_resolution(minimal_png(), 72.0).unwrap();
        assert_eq!(&out[0..8], PNG_SIGNATURE);
        assert_eq!(&out[12..16], b"IHDR");
        // The stamped pHYs lands right after IHDR: length, type, x, y, unit.
        assert_eq!(&out[33..37], &9u32.to_be_bytes());
        assert_eq!(&out[37..41], b"pHYs");
        let ppm = u32::from_be_bytes([out[41], out[42], out[43], out[44]]);
        assert_eq!(ppm, (72.0_f64 / 0.0254).round() as u32);
        assert_eq!(out[49], 1); // unit: metre (data: x, y, unit)
        let count = out.windows(4).filter(|window| *window == *b"pHYs").count();
        assert_eq!(count, 1);
        // IEND type sits before its trailing CRC.
        assert_eq!(&out[out.len() - 8..out.len() - 4], b"IEND");
    }

    #[test]
    fn png_resolution_rejects_non_png() {
        assert!(set_png_resolution(b"not a png".to_vec(), 72.0).is_err());
    }

    #[test]
    fn jpeg_density_patches_jfif_fields() {
        let mut jpeg = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
        jpeg.extend_from_slice(b"JFIF\x00");
        jpeg.extend_from_slice(&[1, 1, 0, 0, 1, 0, 0, 0, 0]);
        let out = set_jpeg_density(jpeg, 144.0);
        assert_eq!(out[13], 1); // units: dots per inch
        assert_eq!(&out[14..16], &144u16.to_be_bytes());
        assert_eq!(&out[16..18], &144u16.to_be_bytes());
    }
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
