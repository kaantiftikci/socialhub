//! Kavşak masaüstü kabuğu.
//!
//! Sorumluluklar:
//! - Node çekirdeğini (packages/core) başlatmak ve uygulama kapanırken durdurmak
//!   (geliştirmede `npm run dev` çekirdeği zaten çalıştırır; o zaman atlanır)
//! - Menü çubuğu simgesi (okunmamış sayısı başlıkta), göster/gizle, çıkış
//! - Kapat düğmesi pencereyi gizler, uygulama arka planda yaşar
//! - Küresel kısayol ⌘⇧K: pencereyi getir/gizle
//! - `set_badge` komutu: arayüz okunmamış sayısını bildirir (Dock rozeti + tray başlığı)

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const CORE_PORT: &str = "7788";

struct CoreProcess(Mutex<Option<Child>>);

/// Çekirdek zaten dinliyorsa (npm run dev) tekrar başlatma.
fn core_is_up() -> bool {
    std::net::TcpStream::connect_timeout(
        &format!("127.0.0.1:{CORE_PORT}").parse().unwrap(),
        std::time::Duration::from_millis(400),
    )
    .is_ok()
}

/// Finder'dan açılan uygulamanın PATH'i kısıtlıdır (nvm/homebrew node görünmez); yaygın yerleri ve
/// kullanıcının kabuğunu deneyerek node'u bul. KAVSAK_NODE ile elle verilebilir.
fn find_node() -> String {
    if let Ok(n) = std::env::var("KAVSAK_NODE") {
        return n;
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let mut candidates: Vec<String> = vec![
        "/opt/homebrew/bin/node".into(),
        "/usr/local/bin/node".into(),
        format!("{home}/.volta/bin/node"),
        format!("{home}/.fnm/aliases/default/bin/node"),
        format!("{home}/.asdf/shims/node"),
    ];
    // nvm: en yeni sürüm
    if let Ok(rd) = std::fs::read_dir(format!("{home}/.nvm/versions/node")) {
        let mut vers: Vec<String> = rd.flatten().map(|e| e.path().join("bin/node").to_string_lossy().to_string()).collect();
        vers.sort();
        vers.reverse();
        candidates.extend(vers);
    }
    for c in &candidates {
        if std::path::Path::new(c).exists() {
            return c.clone();
        }
    }
    // son çare: giriş kabuğuna sor
    if let Ok(out) = Command::new("/bin/zsh").args(["-lc", "command -v node"]).output() {
        let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !p.is_empty() {
            return p;
        }
    }
    "node".into()
}

fn spawn_core(app: &AppHandle) -> Option<Child> {
    if core_is_up() {
        log(app, "çekirdek zaten çalışıyor, yeniden başlatılmadı");
        return None;
    }
    // Geliştirme: KAVSAK_CORE=/yol/packages/core/dist/index.js ; paket: resources/core/dist/index.js
    let entry = std::env::var("KAVSAK_CORE").ok().map(std::path::PathBuf::from).or_else(|| {
        app.path()
            .resource_dir()
            .ok()
            .map(|d| d.join("core").join("dist").join("index.js"))
            .filter(|p| p.exists())
    });
    let Some(entry) = entry else {
        let rd = app.path().resource_dir().ok().map(|d| d.display().to_string()).unwrap_or_default();
        log(app, &format!("çekirdek dosyası bulunamadı (resources: {rd}); paket eksik ya da geliştirme modunda KAVSAK_CORE verilmedi"));
        return None;
    };
    let node = find_node();
    log(app, &format!("node: {node} · çekirdek: {}", entry.display()));
    let core_dir = entry.parent().and_then(|d| d.parent()).map(|p| p.to_path_buf());
    // çekirdek çıktısı ~/.kavsak/core.log'a (Finder'dan açılınca terminal yok)
    let logfile = std::fs::OpenOptions::new().create(true).append(true).open(kavsak_dir().join("core.log")).ok();
    let (out, err) = match logfile {
        Some(f) => (Stdio::from(f.try_clone().unwrap()), Stdio::from(f)),
        None => (Stdio::inherit(), Stdio::inherit()),
    };
    let mut cmd = Command::new(&node);
    cmd.arg(&entry)
        .env("KAVSAK_PORT", CORE_PORT)
        .env("PATH", format!("{}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", std::env::var("PATH").unwrap_or_default()))
        .stdout(out)
        .stderr(err);
    if let Some(dir) = core_dir {
        cmd.current_dir(dir);
    }
    match cmd.spawn() {
        Ok(child) => {
            log(app, &format!("çekirdek başlatıldı: {} {}", node, entry.display()));
            Some(child)
        }
        Err(e) => {
            log(app, &format!("çekirdek başlatılamadı ({node}): {e}"));
            None
        }
    }
}

fn kavsak_dir() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    let d = std::path::PathBuf::from(home).join(".kavsak");
    let _ = std::fs::create_dir_all(&d);
    d
}

/// Finder'dan açılan uygulamanın stderr'i görünmez: ~/.kavsak/desktop.log'a da yaz.
fn log(app: &AppHandle, text: &str) {
    eprintln!("[kavsak-desktop] {text}");
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(kavsak_dir().join("desktop.log")) {
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = writeln!(f, "[{ts}] {text}");
    }
    let _ = app.emit("desktop-log", text);
}

/// Arayüz için: çekirdek/başlatma günlüğünün son satırları
#[tauri::command]
fn core_info() -> String {
    let mut out = String::new();
    for name in ["desktop.log", "core.log"] {
        if let Ok(s) = std::fs::read_to_string(kavsak_dir().join(name)) {
            let lines: Vec<&str> = s.lines().collect();
            let tail = lines.iter().rev().take(25).rev().cloned().collect::<Vec<_>>().join("\n");
            out.push_str(&format!("--- {name} ---\n{tail}\n"));
        }
    }
    out
}

fn toggle_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let visible = w.is_visible().unwrap_or(false);
        let focused = w.is_focused().unwrap_or(false);
        if visible && focused {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Arayüzden çağrılır: okunmamış mesaj sayısı değişti.
#[tauri::command]
fn set_badge(app: AppHandle, count: u32) {
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_title(if count > 0 { Some(count.to_string()) } else { None::<String> });
    }
    #[cfg(target_os = "macos")]
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_badge_count(if count > 0 { Some(count as i64) } else { None });
    }
}

/// Arayüzden çağrılır: kullanıcı bir bildirime tıkladı vb.
#[tauri::command]
fn focus_window(app: AppHandle) {
    show_main(&app);
}

/// Çekirdeğin yerel API belirteci (~/.kavsak/token); WKWebView "null" kaynaklı olduğundan her istekte gönderilir.
#[tauri::command]
fn core_token() -> String {
    std::fs::read_to_string(kavsak_dir().join("token")).map(|s| s.trim().to_string()).unwrap_or_default()
}

#[tauri::command]
fn core_url() -> String {
    format!("http://127.0.0.1:{CORE_PORT}")
}

pub fn run() {
    tauri::Builder::default()
        // Tek örnek: uygulama ikinci kez açılırsa yeni süreç kapanır, var olan pencere öne gelir (ikinci çekirdek
        // aynı WhatsApp oturum dosyalarını açıp Signal oturumunu bozuyordu)
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    let target = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyK);
                    if shortcut == &target && event.state() == ShortcutState::Pressed {
                        toggle_main(app);
                    }
                })
                .build(),
        )
        .manage(CoreProcess(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![set_badge, focus_window, core_url, core_info, core_token])
        .setup(|app| {
            let handle = app.handle().clone();

            // Çekirdek
            let child = spawn_core(&handle);
            *app.state::<CoreProcess>().0.lock().unwrap() = child;

            // Bekçi: çekirdek düşerse (çökme vb.) yeniden başlat
            let wd = handle.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(10));
                let state = wd.state::<CoreProcess>();
                let mut guard = state.0.lock().unwrap();
                let owned = guard.is_some();
                let exited = guard.as_mut().map(|c| matches!(c.try_wait(), Ok(Some(_)))).unwrap_or(false);
                // Açılışta başka bir çekirdek (önceki sürüm vb.) çalışıyordu ve biz başlatmamıştık: o kapanınca kendimizinkini başlat
                if !owned {
                    if !core_is_up() {
                        log(&wd, "dışarıdaki çekirdek kapanmış; kendi çekirdeğimiz başlatılıyor");
                        *guard = spawn_core(&wd);
                    }
                    continue;
                }
                if owned && (exited || !core_is_up()) {
                    if exited {
                        log(&wd, "çekirdek süreci sonlanmış; yeniden başlatılıyor");
                    } else {
                        log(&wd, "çekirdek yanıt vermiyor; yeniden başlatılıyor");
                        if let Some(c) = guard.as_mut() {
                            let _ = c.kill();
                        }
                    }
                    *guard = spawn_core(&wd);
                }
            });

            // Küresel kısayol
            let _ = app
                .global_shortcut()
                .register(Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyK));

            // Menü çubuğu
            let show = MenuItem::with_id(app, "show", "Kavşak’ı Göster", true, Some("CmdOrCtrl+Shift+K"))?;
            let focus = MenuItem::with_id(app, "focus", "Odak modu", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Çıkış", true, Some("CmdOrCtrl+Q"))?;
            let menu = Menu::with_items(app, &[&show, &focus, &PredefinedMenuItem::separator(app)?, &quit])?;

            let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
            TrayIconBuilder::with_id("main")
                .icon(tray_icon)
                .icon_as_template(true)
                .tooltip("Kavşak")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, ev| match ev.id().as_ref() {
                    "show" => show_main(app),
                    "focus" => {
                        show_main(app);
                        let _ = app.emit("navigate", "focus");
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                        toggle_main(tray.app_handle());
                    }
                })
                .build(app)?;

            // Kapat = gizle
            if let Some(w) = app.get_webview_window("main") {
                let wh = w.clone();
                w.on_window_event(move |e| {
                    if let WindowEvent::CloseRequested { api, .. } = e {
                        api.prevent_close();
                        let _ = wh.hide();
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Kavşak başlatılamadı")
        .run(|app, event| match event {
            // Dock simgesine tıklanınca pencereyi geri getir (macOS)
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => show_main(app),
            RunEvent::ExitRequested { .. } | RunEvent::Exit => {
                if let Some(mut child) = app.state::<CoreProcess>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
            _ => {}
        });
}
