// Google Identity Services (GIS) loader + token-client wrapper.
//
// Browser-only OAuth via google.accounts.oauth2.initTokenClient.
// No client secret, no redirect URI, no /oauth/callback route.
// The developer configures VITE_GOOGLE_CLIENT_ID once; the popup
// handles everything else in-page.
//
// SECURITY: GIS returns an access_token only — no refresh_token.
// Silent refresh happens via requestAccessToken({prompt:''}) which
// uses Google's third-party-cookie session under accounts.google.com.

import { log } from '../lib/log';
import { env } from '../lib/env';

// Space-delimited scope list. `drive.file` alone does NOT authorize the
// oauth2/v3/userinfo endpoint — that returned 401 "Invalid Credentials"
// and broke first-time Connect. Adding openid + email + profile lets the
// same access token read the connected account's identity.
export const DRIVE_FILE_SCOPE =
  'openid email profile https://www.googleapis.com/auth/drive.file';

interface GisTokenClient {
  requestAccessToken(opts?: { prompt?: '' | 'consent' | 'select_account' }): void;
}

interface GisTokenResponse {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

interface GisOAuth2 {
  initTokenClient(cfg: {
    client_id: string;
    scope: string;
    prompt?: '' | 'consent' | 'select_account';
    hint?: string;
    callback: (resp: GisTokenResponse) => void;
    error_callback?: (err: { type: string; message?: string }) => void;
  }): GisTokenClient;
  revoke(token: string, cb?: () => void): void;
}

interface GisAccounts {
  oauth2: GisOAuth2;
}

interface GisGlobal {
  accounts: GisAccounts;
}

declare global {
  interface Window {
    google?: GisGlobal;
  }
}

const GIS_SCRIPT_SRC = 'https://accounts.google.com/gsi/client';
const GIS_SCRIPT_ID = 'bv-gis-script';

let loadPromise: Promise<void> | null = null;

export function hasGoogleClientId(): boolean {
  return !!env.googleClientId;
}

export async function loadGis(): Promise<void> {
  if (typeof window === 'undefined') {
    throw new Error('GIS can only load in a browser');
  }
  if (window.google?.accounts?.oauth2) {
    return;
  }
  if (loadPromise) return loadPromise;
  loadPromise = new Promise<void>((resolve, reject) => {
    // If a prior attempt created the tag but load failed, remove and retry.
    const existing = document.getElementById(GIS_SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      existing.remove();
    }
    const s = document.createElement('script');
    s.id = GIS_SCRIPT_ID;
    s.src = GIS_SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => {
      if (window.google?.accounts?.oauth2) {
        log.info('gis', 'GIS script loaded');
        resolve();
      } else {
        loadPromise = null;
        reject(new Error('GIS script loaded but window.google.accounts.oauth2 is missing'));
      }
    };
    s.onerror = () => {
      loadPromise = null;
      reject(new Error('Failed to load Google Identity Services script'));
    };
    document.head.appendChild(s);
  });
  return loadPromise;
}

export interface GisAccessToken {
  accessToken: string;
  expiresAt: number;
  scope: string;
}

export interface RequestAccessTokenArgs {
  clientId: string;
  scope?: string;
  prompt?: '' | 'consent' | 'select_account';
  hint?: string;
}

// Wraps initTokenClient in a promise. Chooses a fresh token client per call
// so the callback closure captures the resolver correctly. GIS reuses the
// same popup across concurrent requests, which is fine for our flow.
export async function requestGisAccessToken(
  args: RequestAccessTokenArgs,
): Promise<GisAccessToken> {
  if (!args.clientId) {
    throw new Error('requestGisAccessToken: clientId required');
  }
  await loadGis();
  const oauth2 = window.google?.accounts?.oauth2;
  if (!oauth2) {
    throw new Error('GIS oauth2 not available after script load');
  }
  const scope = args.scope ?? DRIVE_FILE_SCOPE;
  log.debug('gis', 'requesting access token', {
    prompt: args.prompt ?? '(silent)',
    hint: args.hint ?? null,
  });

  return await new Promise<GisAccessToken>((resolve, reject) => {
    let settled = false;
    const client = oauth2.initTokenClient({
      client_id: args.clientId,
      scope,
      prompt: args.prompt,
      hint: args.hint,
      callback: (resp) => {
        if (settled) return;
        settled = true;
        if (resp.error || !resp.access_token) {
          const msg = resp.error_description || resp.error || 'GIS returned no access_token';
          log.warn('gis', 'token callback error', { error: resp.error, msg });
          reject(new Error(msg));
          return;
        }
        const expiresInMs = Math.max(0, (resp.expires_in ?? 0) * 1000);
        const token: GisAccessToken = {
          accessToken: resp.access_token,
          expiresAt: Date.now() + expiresInMs,
          scope: resp.scope ?? scope,
        };
        log.info('gis', 'access token acquired', {
          scope: token.scope,
          expiresInMs,
        });
        resolve(token);
      },
      error_callback: (err) => {
        if (settled) return;
        settled = true;
        log.warn('gis', 'token error_callback', err);
        reject(new Error(`GIS error: ${err.type}${err.message ? ` (${err.message})` : ''}`));
      },
    });
    try {
      client.requestAccessToken({ prompt: args.prompt });
    } catch (err) {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export function revokeGisToken(accessToken: string): Promise<void> {
  return new Promise((resolve) => {
    if (!accessToken || !window.google?.accounts?.oauth2) {
      resolve();
      return;
    }
    window.google.accounts.oauth2.revoke(accessToken, () => resolve());
  });
}
