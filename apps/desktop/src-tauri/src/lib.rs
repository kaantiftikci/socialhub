//! Mivelo masaüstü kabuğu.
//!
//! Sorumluluklar:
//! - Node çekirdeğini (packages/core) başlatmak ve uygulama kapanırken durdurmak
//!   (geliştirmede `npm run dev` çekirdeği zaten çalıştırır; o zaman atlanır)
//! - Menü çubuğu / sistem tepsisi simgesi (okunmamış sayısı başlıkta; Windows'ta ipucunda), göster/gizle, çıkış
//! - Kapat düğmesi pencereyi gizler, uygulama arka planda yaşar
//! - Küresel kısayol ⌘⇧K (Windows/Linux: Ctrl+Shift+K): pencereyi getir/gizle
//! - `set_badge` komutu: arayüz okunmamış sayısını bildirir (macOS Dock rozeti + tray başlığı)
//!
//! Platformlar: macOS (asıl hedef) ve Windows. Mac'e özgü kodlar `#[cfg(target_os = "macos")]` ile korunur.

use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const CORE_PORT: &str = "7788";

/// Küresel kısayolun değiştiricisi: macOS'ta ⌘, Windows/Linux'ta Ctrl (SUPER orada Windows tuşu olurdu)
#[cfg(target_os = "macos")]
const SHORTCUT_MOD: Modifiers = Modifiers::SUPER;
#[cfg(not(target_os = "macos"))]
const SHORTCUT_MOD: Modifiers = Modifiers::CONTROL;

/// Node ikili dosyasının adı
#[cfg(windows)]
const NODE_BIN: &str = "node.exe";
#[cfg(not(windows))]
const NODE_BIN: &str = "node";

/// Ev dizini: Unix'te HOME, Windows'ta USERPROFILE (Node'un os.homedir() ile aynı; ~/.mivelo ikisinde de aynı yer)
fn home_dir() -> std::path::PathBuf {
    #[cfg(windows)]
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME"));
    #[cfg(not(windows))]
    let home = std::env::var("HOME");
    std::path::PathBuf::from(home.unwrap_or_else(|_| ".".into()))
}

/// Çekirdek süreci + bekçi durumu
#[derive(Default)]
struct CoreState {
    child: Option<Child>,
    /// son başlatma anı (açılış süresi / kararlılık için)
    started: Option<Instant>,
    /// art arda çöküş sayısı (kararlı çalışınca sıfırlanır)
    crashes: u32,
    /// çöküşten sonra bir sonraki başlatma bu andan önce yapılmaz (üstel bekleme)
    retry_at: Option<Instant>,
}

struct CoreProcess(Mutex<CoreState>);

/// Uygulama kapanıyor: bekçi artık çekirdek başlatmaz
static EXITING: AtomicBool = AtomicBool::new(false);

/// Açılışta çekirdeğe dinlemeye başlaması için tanınan süre (Anahtar Zinciri penceresi, DPAPI/PowerShell, büyük DB göçü…)
const STARTUP_GRACE: Duration = Duration::from_secs(60);
/// Bu kadar süre ayakta kalan çekirdek "kararlı" sayılır, çöküş sayacı sıfırlanır
const STABLE_AFTER: Duration = Duration::from_secs(120);
/// Yeniden başlatma beklemesi: 10 sn, 20, 40 … en çok 5 dk
fn backoff(crashes: u32) -> Duration {
    let secs = 10u64.saturating_mul(1u64 << crashes.saturating_sub(1).min(5));
    Duration::from_secs(secs.min(300))
}

/// Süreci sonlandır ve topla (zombi kalmasın). Unix'te önce SIGTERM: çekirdeğin `shutdown`u (registry.stopAll)
/// çalışabilsin; `grace` içinde çıkmazsa SIGKILL. Windows'ta konsolsuz node'a nazik kapatma iletilemez → doğrudan sonlandır.
fn stop_child(mut child: Child, grace: Duration) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill").args(["-TERM", &child.id().to_string()]).stdout(Stdio::null()).stderr(Stdio::null()).status();
        let until = Instant::now() + grace;
        while Instant::now() < until {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    #[cfg(not(unix))]
    let _ = grace;
    let _ = child.kill();
    let _ = child.wait();
}

/// Çekirdek zaten dinliyorsa (npm run dev) tekrar başlatma.
fn core_is_up() -> bool {
    std::net::TcpStream::connect_timeout(
        &format!("127.0.0.1:{CORE_PORT}").parse().unwrap(),
        std::time::Duration::from_millis(400),
    )
    .is_ok()
}

/// Finder'dan açılan uygulamanın PATH'i kısıtlıdır (nvm/homebrew node görünmez); yaygın yerleri ve
/// kullanıcının kabuğunu deneyerek node'u bul. KAVSAK_NODE ile elle verilebilir; pakette gömülü node
/// (Resources/core/bin/node[.exe], CI'da KAVSAK_BUNDLE_NODE=1 ile) varsa önce o kullanılır.
///
/// Yerel modüller (better-sqlite3…) paketlenirken kullanılan node'un ABI'siyle derlenir; `bundle-core.mjs` bunu
/// `core/node-abi.json`a yazar ({modules, version, execPath}). ABI biliniyorsa önce paketleyen node'un kendisi, sonra
/// adaylar arasında ABI'si tutan ilk node seçilir (Homebrew'daki başka ana sürüm NODE_MODULE_VERSION hatasıyla
/// çekirdeği düşürüyordu); hiçbiri tutmazsa eski sıra (ilk bulunan) kullanılır.
fn find_node(bundled: Option<std::path::PathBuf>, abi: Option<&NodeAbi>) -> String {
    if let Ok(n) = std::env::var("KAVSAK_NODE") {
        return n;
    }
    if let Some(b) = bundled.filter(|p| p.exists()) {
        return b.to_string_lossy().to_string();
    }
    let mut list: Vec<String> = Vec::new();
    if let Some(p) = abi.and_then(|a| a.exec_path.clone()) {
        list.push(p);
    }
    list.extend(node_candidates());
    let mut seen = std::collections::HashSet::new();
    list.retain(|c| std::path::Path::new(c).exists() && seen.insert(c.clone()));
    if let Some(want) = abi.map(|a| a.modules.as_str()) {
        if let Some(c) = list.iter().find(|c| node_modules_abi(c).as_deref() == Some(want)) {
            return c.clone();
        }
        if let Some(s) = shell_node() {
            if node_modules_abi(&s).as_deref() == Some(want) {
                return s;
            }
        }
    }
    if let Some(c) = list.into_iter().next() {
        return c;
    }
    shell_node().unwrap_or_else(|| NODE_BIN.into())
}

/// Son çare: kullanıcının kabuğuna / PATH'ine sor
fn shell_node() -> Option<String> {
    // -i: .zshrc de okunsun (PATH çoğunlukla orada); -l yalnız .zprofile okur
    #[cfg(unix)]
    if let Ok(out) = Command::new("/bin/zsh").args(["-ilc", "command -v node"]).stdin(Stdio::null()).output() {
        let p = String::from_utf8_lossy(&out.stdout).lines().map(str::trim).filter(|l| l.starts_with('/')).last().map(str::to_string);
        if p.is_some() {
            return p;
        }
    }
    // Windows: Gezgin'den açılan uygulama kullanıcının PATH'ini zaten alır; `where` ilk eşleşmeyi verir
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if let Ok(out) = Command::new("where").arg("node").creation_flags(CREATE_NO_WINDOW).output() {
            if let Some(p) = String::from_utf8_lossy(&out.stdout).lines().map(str::trim).find(|l| !l.is_empty()) {
                return Some(p.to_string());
            }
        }
    }
    None
}

/// Paketleyen node'un bilgisi (core/node-abi.json)
struct NodeAbi {
    modules: String,
    version: String,
    exec_path: Option<String>,
}

fn read_node_abi(core_dir: &std::path::Path) -> Option<NodeAbi> {
    let raw = std::fs::read_to_string(core_dir.join("node-abi.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let modules = v.get("modules")?.as_str()?.to_string();
    if modules.is_empty() {
        return None;
    }
    Some(NodeAbi {
        modules,
        version: v.get("version").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        exec_path: v.get("execPath").and_then(|x| x.as_str()).filter(|s| !s.is_empty()).map(str::to_string),
    })
}

/// Bir node ikilisinin yerel modül ABI'si (process.versions.modules), çalıştırılamazsa None
fn node_modules_abi(node: &str) -> Option<String> {
    let mut cmd = Command::new(node);
    cmd.args(["-p", "process.versions.modules"]).stdin(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// "v22.10.1" → (22, 10, 1); sürüm olmayan adlar en sona düşer
fn version_key(name: &str) -> (u64, u64, u64) {
    let mut it = name.trim_start_matches('v').split('.').map(|p| p.parse::<u64>().unwrap_or(0));
    (it.next().unwrap_or(0), it.next().unwrap_or(0), it.next().unwrap_or(0))
}

/// nvm klasöründeki sürümler, en yenisi önce (sözlük sırası değil: v9 > v22 sanılmasın)
fn nvm_versions(dir: &str, bin: &str) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut vers: Vec<((u64, u64, u64), String)> = rd
        .flatten()
        .map(|e| (version_key(&e.file_name().to_string_lossy()), e.path().join(bin).to_string_lossy().to_string()))
        .collect();
    vers.sort_by(|a, b| b.0.cmp(&a.0));
    vers.into_iter().map(|(_, p)| p).collect()
}

/// macOS/Linux: Finder/Dock'tan açılınca PATH launchd'nin kısıtlı yolu: terminalden çalışan `node` görünmez. Bilinen kurulum yerleri:
#[cfg(not(windows))]
fn node_candidates() -> Vec<String> {
    let home = home_dir().to_string_lossy().to_string();
    let mut candidates: Vec<String> = vec![
        format!("{home}/.local/node/bin/node"),
        format!("{home}/.local/bin/node"),
        "/opt/homebrew/bin/node".into(),
        "/usr/local/bin/node".into(),
        format!("{home}/.volta/bin/node"),
        format!("{home}/.fnm/aliases/default/bin/node"),
        format!("{home}/.asdf/shims/node"),
    ];
    // nvm: en yeni sürüm
    candidates.extend(nvm_versions(&format!("{home}/.nvm/versions/node"), "bin/node"));
    candidates
}

/// Windows: resmi kurulum, nvm-windows, Volta, fnm, Scoop
#[cfg(windows)]
fn node_candidates() -> Vec<String> {
    let env = |k: &str| std::env::var(k).unwrap_or_default();
    let (pf, pf86, local, roaming) = (env("ProgramFiles"), env("ProgramFiles(x86)"), env("LOCALAPPDATA"), env("APPDATA"));
    let home = home_dir().to_string_lossy().to_string();
    let mut candidates: Vec<String> = Vec::new();
    if !env("NVM_SYMLINK").is_empty() {
        candidates.push(format!("{}\\node.exe", env("NVM_SYMLINK")));
    }
    candidates.extend([
        format!("{pf}\\nodejs\\node.exe"),
        format!("{pf86}\\nodejs\\node.exe"),
        format!("{local}\\Programs\\nodejs\\node.exe"),
        format!("{local}\\Volta\\bin\\node.exe"),
        format!("{roaming}\\fnm\\aliases\\default\\node.exe"),
        format!("{home}\\scoop\\apps\\nodejs-lts\\current\\node.exe"),
        format!("{home}\\scoop\\apps\\nodejs\\current\\node.exe"),
    ]);
    // nvm-windows: en yeni sürüm (%APPDATA%\nvm\v22.x.y\node.exe)
    let nvm_home = if env("NVM_HOME").is_empty() { format!("{roaming}\\nvm") } else { env("NVM_HOME") };
    candidates.extend(nvm_versions(&nvm_home, "node.exe"));
    candidates.into_iter().filter(|c| !c.starts_with('\\')).collect()
}

/// Windows: konsol uygulaması (node.exe, where) başlatılınca siyah pencere açılmasın
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Çekirdeğin PATH'i: ffmpeg/pkill gibi araçlar Finder'dan açılışta da bulunsun (Windows: winget kısayolları)
fn core_path() -> std::ffi::OsString {
    let mut dirs: Vec<std::path::PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    #[cfg(not(windows))]
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].map(std::path::PathBuf::from));
    #[cfg(windows)]
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        dirs.push(std::path::PathBuf::from(local).join("Microsoft").join("WinGet").join("Links"));
    }
    std::env::join_paths(dirs).unwrap_or_default()
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
    let core_dir = entry.parent().and_then(|d| d.parent()).map(|p| p.to_path_buf());
    let bundled = core_dir.as_ref().map(|core| core.join("bin").join(NODE_BIN));
    let abi = core_dir.as_deref().and_then(read_node_abi);
    let node = find_node(bundled, abi.as_ref());
    log(app, &format!("node: {node} · çekirdek: {}", entry.display()));
    if let Some(a) = &abi {
        match node_modules_abi(&node) {
            Some(m) if m == a.modules => {}
            got => log(app, &format!(
                "uyarı: çekirdek node {} (ABI {}) ile paketlendi, seçilen node'un ABI'si {}: yerel modüller yüklenemeyebilir (KAVSAK_NODE ile doğru node'u ver)",
                a.version, a.modules, got.unwrap_or_else(|| "?".into())
            )),
        }
    }
    // çekirdek çıktısı ~/.mivelo/core.log'a (Finder'dan açılınca terminal yok)
    let logfile = std::fs::OpenOptions::new().create(true).append(true).open(kavsak_dir().join("core.log")).ok();
    let (out, err) = match logfile.and_then(|f| f.try_clone().ok().map(|c| (c, f))) {
        Some((c, f)) => (Stdio::from(c), Stdio::from(f)),
        None => (Stdio::inherit(), Stdio::inherit()),
    };
    let mut cmd = Command::new(&node);
    cmd.arg(&entry)
        .env("KAVSAK_PORT", CORE_PORT)
        .env("PATH", core_path())
        .stdout(out)
        .stderr(err);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
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
    let d = home_dir().join(".mivelo"); // eski adı .kavsak (çekirdek ilk açılışta taşır)
    let _ = std::fs::create_dir_all(&d);
    d
}

/// Finder'dan açılan uygulamanın stderr'i görünmez: ~/.mivelo/desktop.log'a da yaz.
fn log(app: &AppHandle, text: &str) {
    eprintln!("[kavsak-desktop] {text}");
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(kavsak_dir().join("desktop.log")) {
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = writeln!(f, "[{ts}] {text}");
    }
    let _ = app.emit("desktop-log", text);
}

/// Dış bağlantı / uygulama şeması (whatsapp://, slack://, imessage://, https://): sistemin varsayılan uygulamasıyla aç
#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if !(url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:") || url.starts_with("tel:") || url.starts_with("whatsapp://") || url.starts_with("slack://") || url.starts_with("imessage://") || url.starts_with("tg://")) {
        return Err("izin verilmeyen adres".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
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
        // tepsi başlığı macOS/Linux'ta görünür; Windows'ta desteklenmez, sayı ipucunda gösterilir
        #[cfg(not(windows))]
        let _ = tray.set_title(if count > 0 { Some(count.to_string()) } else { None::<String> });
        #[cfg(windows)]
        let _ = tray.set_tooltip(Some(if count > 0 { format!("Mivelo · {count} okunmamış") } else { "Mivelo".to_string() }));
    }
    // Windows görev çubuğu rozeti (overlay simgesi) şimdilik yok: sayı tepsi ipucunda
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

/// Çekirdeğin yerel API belirteci (~/.mivelo/token); WKWebView "null" kaynaklı olduğundan her istekte gönderilir
/// (Windows WebView2 kaynağı http://tauri.localhost: yerel sayılır, yine de gönderilir).
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
                    let target = Shortcut::new(Some(SHORTCUT_MOD | Modifiers::SHIFT), Code::KeyK);
                    if shortcut == &target && event.state() == ShortcutState::Pressed {
                        toggle_main(app);
                    }
                })
                .build(),
        )
        .manage(CoreProcess(Mutex::new(CoreState::default())))
        .invoke_handler(tauri::generate_handler![set_badge, focus_window, core_url, core_info, core_token, open_external])
        .setup(|app| {
            let handle = app.handle().clone();

            // Çekirdek
            let child = spawn_core(&handle);
            {
                let state = app.state::<CoreProcess>();
                let mut st = state.0.lock().unwrap_or_else(|p| p.into_inner());
                st.started = child.as_ref().map(|_| Instant::now());
                st.child = child;
            }

            // Bekçi: çekirdek düşerse (çökme vb.) yeniden başlat. Açılışta STARTUP_GRACE boyunca "dinlemiyor" diye
            // öldürülmez; art arda çöküşlerde bekleme üstel artar (10 sn → ≤5 dk), sonsuz hızlı döngü yok.
            let wd = handle.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(5));
                if EXITING.load(Ordering::SeqCst) {
                    break;
                }
                let state = wd.state::<CoreProcess>();
                let mut st = state.0.lock().unwrap_or_else(|p| p.into_inner());
                if EXITING.load(Ordering::SeqCst) {
                    break;
                }
                let now = Instant::now();
                let alive_for = st.started.map(|s| now.duration_since(s)).unwrap_or_default();
                if let Some(c) = st.child.as_mut() {
                    let exited = match c.try_wait() {
                        Ok(Some(status)) => Some(status.to_string()),
                        Ok(None) => None,
                        Err(e) => Some(format!("durum okunamadı: {e}")),
                    };
                    let reason = if let Some(status) = exited {
                        st.child = None; // try_wait süreci topladı
                        Some(format!("çekirdek süreci sonlandı ({status})"))
                    } else if alive_for >= STARTUP_GRACE && !core_is_up() {
                        if let Some(c) = st.child.take() {
                            stop_child(c, Duration::from_secs(3));
                        }
                        Some("çekirdek yanıt vermiyor; durduruldu".to_string())
                    } else {
                        if alive_for >= STABLE_AFTER && st.crashes > 0 {
                            st.crashes = 0;
                        }
                        None
                    };
                    if let Some(reason) = reason {
                        // kısa sürede düşen çekirdek art arda çöküş sayılır; uzun çalıştıysa sayaç baştan
                        st.crashes = if alive_for >= STABLE_AFTER { 1 } else { st.crashes.saturating_add(1) };
                        let wait = backoff(st.crashes);
                        st.retry_at = Some(now + wait);
                        st.started = None;
                        log(&wd, &format!("{reason}; {} sn sonra yeniden başlatılacak (art arda {}. kez)", wait.as_secs(), st.crashes));
                    }
                    continue;
                }
                if st.retry_at.is_some_and(|t| now < t) {
                    continue;
                }
                // Sahipsiz: ya çöküş sonrası bekleme bitti ya da açılışta başka bir çekirdek (npm run dev, önceki sürüm)
                // çalışıyordu: o da kapandıysa kendimizinkini başlat
                if core_is_up() {
                    st.retry_at = None;
                    continue;
                }
                if st.retry_at.is_none() {
                    log(&wd, "dışarıdaki çekirdek kapanmış; kendi çekirdeğimiz başlatılıyor");
                }
                st.retry_at = None;
                match spawn_core(&wd) {
                    Some(c) => {
                        st.child = Some(c);
                        st.started = Some(Instant::now());
                    }
                    None if !core_is_up() => {
                        // başlatılamadı (node/çekirdek dosyası yok): aynı üstel beklemeyle tekrar dene
                        st.crashes = st.crashes.saturating_add(1);
                        let wait = backoff(st.crashes);
                        st.retry_at = Some(Instant::now() + wait);
                        log(&wd, &format!("çekirdek başlatılamadı; {} sn sonra yeniden denenecek", wait.as_secs()));
                    }
                    None => {}
                }
            });

            // Küresel kısayol (⌘⇧K / Ctrl+Shift+K)
            let _ = app
                .global_shortcut()
                .register(Shortcut::new(Some(SHORTCUT_MOD | Modifiers::SHIFT), Code::KeyK));

            // Menü çubuğu
            let show = MenuItem::with_id(app, "show", "Mivelo’yu Göster", true, Some("CmdOrCtrl+Shift+K"))?;
            let focus = MenuItem::with_id(app, "focus", "Odak modu", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Çıkış", true, Some("CmdOrCtrl+Q"))?;
            let menu = Menu::with_items(app, &[&show, &focus, &PredefinedMenuItem::separator(app)?, &quit])?;

            // macOS: siyah şablon simge (menü çubuğu temaya göre boyar); Windows/Linux: şablon desteklenmez, siyah simge
            // koyu görev çubuğunda kaybolur → renkli uygulama simgesi
            #[cfg(target_os = "macos")]
            let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
            #[cfg(not(target_os = "macos"))]
            let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?;
            TrayIconBuilder::with_id("main")
                .icon(tray_icon)
                .icon_as_template(true)
                .tooltip("Mivelo")
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
        .expect("Mivelo başlatılamadı")
        .run(|app, event| match event {
            // Dock simgesine tıklanınca pencereyi geri getir (macOS)
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => show_main(app),
            RunEvent::ExitRequested { .. } | RunEvent::Exit => {
                // önce bayrak: bekçi bundan sonra yeni çekirdek başlatmaz (kilidi tutarken başlattıysa aşağıda alınıp durdurulur)
                EXITING.store(true, Ordering::SeqCst);
                let child = app.state::<CoreProcess>().0.lock().unwrap_or_else(|p| p.into_inner()).child.take();
                if let Some(child) = child {
                    // SIGTERM → çekirdek connector'ları düzgün kapatır; 4 sn'de çıkmazsa zorla
                    stop_child(child, Duration::from_secs(4));
                }
            }
            _ => {}
        });
}
