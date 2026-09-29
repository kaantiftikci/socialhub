#!/usr/bin/env node
// GitHub Actions canlı izleyici (Kaan, 29.09: "otomatik başlayınca takip edebileceğimiz bir terminal").
// Kullanım: npm run ci            → canlı izle (yeni çalışmalar kendiliğinden eklenir, bitince macOS bildirimi)
//           npm run ci -- --once  → bir kez yaz ve çık
//           npm run ci -- --logs  → başarısız adımın son 40 satırını da göster (giriş gerekir: `gh auth login`)
// Depo herkese açık: girişsiz çalışır (saatte 60 istek; ETag'li 304 yanıtları sayılmaz). `gh` kuruluysa onun belirteci
// kullanılır (saatte 5000). Belirteç hiçbir yere yazılmaz/yazdırılmaz.
import { execSync, execFileSync } from 'node:child_process';

const args = new Set(process.argv.slice(2));
const ONCE = args.has('--once');
const LOGS = args.has('--logs');

function repoSlug() {
  try {
    const u = execSync('git remote get-url origin', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const m = u.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
    if (m) return `${m[1]}/${m[2]}`;
  } catch {
    /* git yok */
  }
  return 'kaantiftikci/socialhub';
}
const REPO = process.env.CI_REPO || repoSlug();

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execSync('gh auth token', { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString().trim() || undefined;
  } catch {
    return undefined;
  }
}
let TOKEN = token();

const etags = new Map();
const cache = new Map();
let rate = { left: '?', reset: 0 };
async function gh(path) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'mivelo-ci-watch' };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const et = etags.get(path);
  if (et) headers['if-none-match'] = et;
  const r = await fetch(`https://api.github.com/repos/${REPO}${path}`, { headers });
  rate = { left: r.headers.get('x-ratelimit-remaining') ?? rate.left, reset: Number(r.headers.get('x-ratelimit-reset') ?? 0) * 1000 };
  if (r.status === 304) return cache.get(path);
  // geçersiz/süresi dolmuş belirteç: girişsiz devam (depo herkese açık)
  if (r.status === 401 && TOKEN) {
    TOKEN = undefined;
    etags.delete(path);
    return gh(path);
  }
  if (r.status === 403 || r.status === 429) throw new Error(`GitHub istek sınırı doldu (${new Date(rate.reset).toLocaleTimeString('tr-TR')}'de açılır). Daha sık güncelleme için: gh auth login`);
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  const body = path.includes('/logs') ? await r.text() : await r.json();
  if (r.headers.get('etag')) etags.set(path, r.headers.get('etag'));
  cache.set(path, body);
  return body;
}

// ---- biçim ----
const tty = process.stdout.isTTY;
const c = (n) => (s) => (tty ? `\x1b[${n}m${s}\x1b[0m` : s);
const dim = c(2), bold = c(1), red = c(31), green = c(32), yellow = c(33), cyan = c(36), gray = c(90);
const dur = (a, b) => {
  if (!a) return '';
  const s = Math.max(0, Math.round(((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)} sa ${Math.floor((s % 3600) / 60)} dk` : s >= 60 ? `${Math.floor(s / 60)} dk ${s % 60} sn` : `${s} sn`;
};
const SPIN = ['◐', '◓', '◑', '◒'];
let tick = 0;
function icon(status, conclusion) {
  if (status !== 'completed') return status === 'in_progress' ? yellow(SPIN[tick % 4]) : gray('○');
  return { success: green('✓'), failure: red('✗'), cancelled: gray('⊘'), skipped: gray('–'), timed_out: red('⏱') }[conclusion] ?? gray('?');
}
const TR = { success: 'başarılı', failure: 'başarısız', cancelled: 'iptal', skipped: 'atlandı', timed_out: 'zaman aşımı', queued: 'sırada', in_progress: 'sürüyor', waiting: 'bekliyor', requested: 'istendi', pending: 'bekliyor' };
const ago = (t) => {
  const m = Math.round((Date.now() - Date.parse(t)) / 60000);
  return m < 1 ? 'az önce' : m < 60 ? `${m} dk önce` : m < 1440 ? `${Math.round(m / 60)} sa önce` : `${Math.round(m / 1440)} gün önce`;
};

// ---- bildirim ----
function notify(title, text) {
  if (tty) process.stdout.write('\x07');
  if (process.platform !== 'darwin') return;
  try {
    execFileSync('osascript', ['-e', `display notification ${JSON.stringify(text)} with title ${JSON.stringify(title)} sound name "Glass"`], { stdio: 'ignore', timeout: 5000 });
  } catch {
    /* bildirim izni yok */
  }
}

const seen = new Map(); // çalışma → son durum (bitiş bildirimi için)
const logsShown = new Set();

async function frame() {
  const { workflow_runs: runs = [] } = (await gh('/actions/runs?per_page=12')) ?? {};
  // yakın zamandakiler: sürenler + son 3 saatte bitenler (en çok 6); hiçbiri yoksa en son 3
  const recent = runs.filter((r) => r.status !== 'completed' || Date.now() - Date.parse(r.updated_at) < 3 * 3600_000).slice(0, 6);
  const show = recent.length ? recent : runs.slice(0, 3);
  const lines = [];
  lines.push(`${bold('Mivelo · GitHub Actions')}  ${dim(REPO)}  ${dim(new Date().toLocaleTimeString('tr-TR'))}  ${dim(`istek hakkı ${rate.left}${TOKEN ? '' : ' (girişsiz)'}`)}`);
  lines.push('');
  for (const r of show) {
    const title = (r.display_title && r.display_title !== r.name ? r.display_title : r.head_commit?.message || '').split('\n')[0].slice(0, 70);
    const state = r.status === 'completed' ? TR[r.conclusion] ?? r.conclusion : TR[r.status] ?? r.status;
    lines.push(`${icon(r.status, r.conclusion)} ${bold(r.name)} ${dim(`#${r.run_number}`)}  ${state}  ${dim(dur(r.run_started_at, r.status === 'completed' ? r.updated_at : undefined))}  ${gray(ago(r.created_at))}`);
    if (title && title !== r.name) lines.push(`   ${dim(title)}`);
    // iş ayrıntısı yalnız sürenler ve son 30 dk'da bitenler için (istek hakkı)
    if (r.status !== 'completed' || Date.now() - Date.parse(r.updated_at) < 30 * 60_000) {
      const { jobs = [] } = (await gh(`/actions/runs/${r.id}/jobs?per_page=30`)) ?? {};
      for (const j of jobs) {
        const step = j.status === 'in_progress' ? (j.steps ?? []).find((s) => s.status === 'in_progress') : undefined;
        const failed = j.conclusion === 'failure' ? (j.steps ?? []).find((s) => s.conclusion === 'failure') : undefined;
        lines.push(`   ${icon(j.status, j.conclusion)} ${j.name.padEnd(22)} ${dim(dur(j.started_at, j.completed_at).padEnd(12))} ${step ? cyan(`→ ${step.name}`) : failed ? red(`✗ ${failed.name}`) : ''}`);
        if (failed && LOGS && TOKEN && !logsShown.has(j.id)) {
          logsShown.add(j.id);
          try {
            const log = String(await gh(`/actions/jobs/${j.id}/logs`));
            const tail = log.trimEnd().split('\n').slice(-40).map((l) => `      ${gray(l.replace(/^\S+Z /, ''))}`);
            lines.push(...tail);
          } catch (e) {
            lines.push(`      ${gray(`günlük alınamadı: ${e.message}`)}`);
          }
        }
      }
    }
    lines.push(`   ${gray(r.html_url)}`);
    lines.push('');
    // bitiş bildirimi (izleme başladığında zaten bitmiş olanlar için değil)
    const prev = seen.get(r.id);
    if (prev && prev !== 'completed' && r.status === 'completed') notify(`${r.name} #${r.run_number} ${TR[r.conclusion] ?? r.conclusion}`, `${title} · ${dur(r.run_started_at, r.updated_at)}`);
    if (!prev && seen.size && r.status !== 'completed') notify(`${r.name} #${r.run_number} başladı`, title);
    seen.set(r.id, r.status);
  }
  for (const r of runs) if (!seen.has(r.id)) seen.set(r.id, r.status); // ilk turda eskiler için bildirim yok
  const active = runs.some((r) => r.status !== 'completed');
  if (!ONCE) lines.push(dim(`Çıkmak için Ctrl+C · ${Math.round(waitMs(active) / 1000)} sn'de bir yenilenir${LOGS ? '' : ' · hata günlüğü için: npm run ci -- --logs'}`));
  return { text: lines.join('\n'), active };
}

// girişsizken istek hakkını koru (60/sa; 304 yanıtları sayılmaz): süren iş varken 15 sn, boşta 60 sn
const waitMs = (active) => (TOKEN ? (active ? 5000 : 20_000) : active ? 15_000 : 60_000);

async function main() {
  for (;;) {
    let active = false;
    try {
      const f = await frame();
      active = f.active;
      if (tty && !ONCE) process.stdout.write('\x1b[H\x1b[2J');
      process.stdout.write(`${f.text}\n`);
    } catch (e) {
      process.stdout.write(`${red('Hata:')} ${e.message}\n`);
      if (ONCE) process.exit(1);
    }
    if (ONCE) return;
    tick++;
    await new Promise((r) => setTimeout(r, waitMs(active)));
  }
}
main();
