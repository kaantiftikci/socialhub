/** Statik sitede ayarlardan çıkış, kayıt ekranına döner. */
let leavePanel: (() => void) | null = null;

export function setLeaveDemoPanel(fn: (() => void) | null): void {
  leavePanel = fn;
}

export function leaveDemoPanel(): void {
  leavePanel?.();
}
