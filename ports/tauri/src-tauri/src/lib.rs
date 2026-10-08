mod comp;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            comp::pick_folder,
            comp::list_projects,
            comp::load_project,
            comp::save_manifest,
            comp::export_png
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Compositor port");
}
