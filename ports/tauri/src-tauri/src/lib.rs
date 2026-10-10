mod comp;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            comp::pick_folder,
            comp::pick_save_path,
            comp::list_projects,
            comp::load_project,
            comp::save_project,
            comp::export_file,
            comp::import_images
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Compositor port");
}
