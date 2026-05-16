/**
 * GitHub App helpers — JWT signing (RS256), state-token management,
 * installation token retrieval. Avoids extra deps by using node:crypto.
 */
import { createSign, randomBytes } from 'node:crypto';

const STATE_TTL_MS = 10 * 60_000;

interface StateEntry {
  project_id: string;
  user_id: string;
  expires: number;
}

// In-memory state map. Process-local; safe for single-replica Railway.
// For multi-replica, swap to a shared store.
const stateMap = new Map<string, StateEntry>();

function pruneExpiredStates(now = Date.now()): void {
  for (const [key, value] of stateMap) {
    if (value.expires <= now) stateMap.delete(key);
  }
}

export function createState(projectId: string, userId: string): string {
  pruneExpiredStates();
  const token = randomBytes(24).toString('hex');
  stateMap.set(token, {
    project_id: projectId,
    user_id: userId,
    expires: Date.now() + STATE_TTL_MS,
  });
  return token;
}

/** Consume a state token (single-use). Returns null if missing or expired. */
export function consumeState(token: string): StateEntry | null {
  pruneExpiredStates();
  const entry = stateMap.get(token);
  if (!entry) return null;
  stateMap.delete(token);
  if (entry.expires <= Date.now()) return null;
  return entry;
}

/** Test-only: clear the state map. */
export function _resetStateMap(): void {
  stateMap.clear();
}

/** Test-only: introspect map size. */
export function _stateMapSize(): number {
  return stateMap.size;
}

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  appSlug: string;
  clientId?: string;
  clientSecret?: string;
}

export function getGitHubAppConfig(): GitHubAppConfig | null {
  const appId = process.env['GITHUB_APP_ID'];
  const rawKey = process.env['GITHUB_APP_PRIVATE_KEY'];
  const appSlug = process.env['GITHUB_APP_SLUG'];
  if (!appId || !rawKey || !appSlug) return null;
  // Allow PEM with literal "\n" sequences (common in env-var hosting).
  const privateKey = rawKey.includes('-----BEGIN')
    ? rawKey.replace(/\\n/g, '\n')
    : rawKey;
  return {
    appId,
    privateKey,
    appSlug,
    clientId: process.env['GITHUB_APP_CLIENT_ID'],
    clientSecret: process.env['GITHUB_APP_CLIENT_SECRET'],
  };
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/** Sign a GitHub App JWT (RS256, 60s lifetime). */
export function signAppJwt(config: GitHubAppConfig): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iat: now - 60,
    exp: now + 9 * 60, // GitHub allows up to 10 minutes; 9 to leave clock margin
    iss: config.appId,
  };
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(config.privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

export interface GitHubInstallation {
  id: number;
  account: { login: string; type: string } | null;
  repository_selection?: 'all' | 'selected';
  permissions?: Record<string, string>;
}

interface InstallationTokenResponse {
  token: string;
  expires_at: string;
  permissions?: Record<string, string>;
  repository_selection?: 'all' | 'selected';
}

const GITHUB_API = 'https://api.github.com';

async function githubFetch(url: string, init: RequestInit): Promise<Response> {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'annotate-app',
    ...(init.headers as Record<string, string> | undefined),
  };
  return fetch(url, { ...init, headers });
}

export async function fetchInstallation(
  config: GitHubAppConfig,
  installationId: string
): Promise<GitHubInstallation> {
  const jwtToken = signAppJwt(config);
  const res = await githubFetch(`${GITHUB_API}/app/installations/${encodeURIComponent(installationId)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${jwtToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub installation lookup failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<GitHubInstallation>;
}

export async function listInstallations(config: GitHubAppConfig): Promise<GitHubInstallation[]> {
  const jwtToken = signAppJwt(config);
  const res = await githubFetch(`${GITHUB_API}/app/installations?per_page=100`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${jwtToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub installations lookup failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<GitHubInstallation[]>;
}

export async function createInstallationToken(
  config: GitHubAppConfig,
  installationId: string
): Promise<InstallationTokenResponse> {
  const jwtToken = signAppJwt(config);
  const res = await githubFetch(`${GITHUB_API}/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwtToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub installation token failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<InstallationTokenResponse>;
}

export async function revokeInstallation(
  config: GitHubAppConfig,
  installationId: string
): Promise<{ ok: boolean; status: number }> {
  const jwtToken = signAppJwt(config);
  const res = await githubFetch(`${GITHUB_API}/app/installations/${encodeURIComponent(installationId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${jwtToken}` },
  });
  return { ok: res.ok, status: res.status };
}
