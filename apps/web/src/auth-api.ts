export interface SessionUser {
  id: string;
  name: string;
  username: string;
}

/** Ağ hatası tarayıcının İngilizce "Failed to fetch" iletisiyle değil, Türkçe görünsün */
async function net(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    throw new Error('Sunucuya ulaşılamadı. İnternet bağlantını kontrol edip tekrar dene.');
  }
}

async function call<T>(action: string, method: string, body?: unknown): Promise<T> {
  const res = await net(`/api/index.php?action=${action}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error || 'İstek başarısız');
  return data as T;
}

export async function authMe(): Promise<SessionUser | null> {
  const res = await net('/api/index.php?action=me', { credentials: 'same-origin' });
  if (res.status === 401) return null;
  const data = (await res.json().catch(() => ({}))) as { user?: SessionUser; error?: string };
  if (!res.ok || !data.user) throw new Error(data.error || 'Oturum okunamadı');
  return data.user;
}

export function authLogin(username: string, password: string): Promise<{ user: SessionUser }> {
  return call('login', 'POST', { username, password });
}

export function authLogout(): Promise<{ ok: boolean }> {
  return call('logout', 'POST');
}

export async function authLoadAccounts(): Promise<Array<Record<string, unknown>>> {
  const data = await call<{ accounts: Array<Record<string, unknown>> }>('accounts', 'GET');
  return data.accounts ?? [];
}

export function authSaveAccounts(accounts: Array<Record<string, unknown>>): Promise<unknown> {
  return call('accounts', 'PUT', { accounts });
}
