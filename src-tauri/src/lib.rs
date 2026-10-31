mod ipc;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};

/// Show or hide the floating pet and tell every window (the pet's own controller stops/starts
/// its pointer polling from this event).
fn set_pet_visible(app: &AppHandle, visible: bool) {
    if let Some(win) = app.get_webview_window("main") {
        if visible {
            let _ = win.show();
            let _ = win.set_always_on_top(true);
        } else {
            let _ = win.hide();
        }
        let _ = app.emit("kibo:visibility", visible);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Tray icon: always available, so Kibo can be hidden, restored or rescued from off-screen.
            let show = MenuItem::with_id(app, "show", "Show Kibo", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "Hide Kibo", true, None::<&str>)?;
            let reset = MenuItem::with_id(app, "reset", "Bring Kibo back on screen", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Kibo", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &hide, &reset, &quit])?;

            let mut tray = TrayIconBuilder::new()
                .tooltip("Kibo")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => set_pet_visible(app, true),
                    "hide" => set_pet_visible(app, false),
                    "reset" => {
                        // the pet window moves itself to a safe spot (it knows its own size and monitors)
                        set_pet_visible(app, true);
                        let _ = app.emit("kibo:reset-position", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            // Optional local event listener (build/task events from `kibo-report`). If it cannot
            // start, Kibo works exactly as before.
            match app.path().app_local_data_dir() {
                Ok(dir) => {
                    if let Err(e) = ipc::start(app.handle(), dir) {
                        eprintln!("Kibo: event listener unavailable: {e}");
                    }
                }
                Err(e) => eprintln!("Kibo: no app data directory, event listener disabled: {e}"),
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Kibo")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Ok(dir) = app.path().app_local_data_dir() {
                    ipc::cleanup(&dir);
                }
            }
        });
}
