; Mivelo NSIS kancaları (tauri.windows.conf.json → bundle.windows.nsis.installerHooks)
;
; Güncelleme/kaldırma öncesi kurulum klasöründen çalışan süreçler kapatılır: Tauri'nin CheckIfAppIsRunning'i yalnız
; Mivelo.exe'yi sonlandırıyor, çekirdek (core\bin\node.exe) yaşamaya devam edip node.exe ve better_sqlite3.node dosyalarını
; kilitli tutuyordu → "Error opening file for writing", yarım güncelleme; yeni kabuk da eski çekirdeği benimsiyordu.
; Sıra: önce kabuk (bekçisi çekirdeği yeniden başlatmasın), sonra node. Kaldırıcının kendisi (uninstall*, Au_*) atlanır.
; Yol ortam değişkeniyle geçer (kullanıcı adındaki ' gibi karakterler PowerShell dizesini bozmasın).
!macro MIVELO_STOP_RUNNING
  System::Call 'Kernel32::SetEnvironmentVariable(t "MIVELO_INSTDIR", t "$INSTDIR")i'
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d = $$env:MIVELO_INSTDIR.TrimEnd('\') + '\'; $$ps = @(Get-CimInstance Win32_Process | Where-Object { $$_.ProcessId -ne $$PID -and $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$d, [StringComparison]::OrdinalIgnoreCase) -and $$_.Name -notlike 'uninstall*' -and $$_.Name -notlike 'Au_*' }); $$ps | Where-Object { $$_.Name -ne 'node.exe' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 300; $$ps | Where-Object { $$_.Name -eq 'node.exe' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; if ($$ps.Count) { Start-Sleep -Milliseconds 700 }"`
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro MIVELO_STOP_RUNNING
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro MIVELO_STOP_RUNNING
!macroend
