// connectDrive — the single browser-only entry point for acquiring Drive
// access under GIS. Called by:
//   - Onboarding "Connect Google Drive" button
//   - RestoreWizard "Connect Google Drive" button
//   - Settings → Data & Backup "Reconnect" button
//
// SECURITY:
//   - Never accepts client secret / redirect URI (there is none under GIS).
//   - Access token is written ONLY to the private drive_tokens IndexedDB.
//   - Never written to CSV / snapshot / journal / manifest (assertNoTokenLeak
//     in tokenStore guards writes on that side).
//
// Silent refresh: pass {prompt: ''} — GIS uses the accounts.google.com session
// to hand back a fresh token without a popup, IF the user has a live session.
// If not, throws — caller decides whether to surface DriveNeedsReconnectError.

import { log } from '../lib/log';
import { env } from '../lib/env';
import {
  requestGisAccessToken,
  revokeGisToken,
  DRIVE_FILE_SCOPE,
  hasRequiredDriveScopes,
} from '../auth/gis';
import { saveTokens, loadTokens, clearTokens } from './tokenStore';

const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo';

const silentRefreshes = new Map<string, Promise<string>>();

export interface DriveIdentity {
  email: string;
  sub: string;
  name?: string;
  picture?: string;
}

export interface ConnectDriveArgs {
  businessId: string;
  prompt?: '' | 'consent' | 'select_account';
  hint?: string;
}

export interface ConnectDriveResult {
  accessToken: string;
  expiresAt: number;
  identity: DriveIdentity;
}

async function fetchUserInfo(accessToken: string): Promise<DriveIdentity> {
  const res = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    log.warn('connectDrive', 'userinfo failed', { status: res.status, body: text });
    throw new Error(`Google userinfo failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    email?: string;
    sub?: string;
    name?: string;
    picture?: string;
  };
  if (!body.email || !body.sub) {
    throw new Error('Google userinfo missing email/sub');
  }
  return {
    email: body.email,
    sub: body.sub,
    name: body.name,
    picture: body.picture,
  };
}

export async function connectDrive(args: ConnectDriveArgs): Promise<ConnectDriveResult> {
  if (!env.googleClientId) {
    throw new Error(
      'Google Drive is not configured. Set VITE_GOOGLE_CLIENT_ID in .env.local and reload.',
    );
  }
  if (!args.businessId) {
    throw new Error('connectDrive: businessId required');
  }

  log.info('connectDrive', 'begin', {
    businessId: args.businessId,
    prompt: args.prompt ?? '(silent)',
  });

  // If we already have a token for this business, use its email as a hint so
  // GIS re-authenticates the same account (avoids account-switch surprises).
  const existing = await loadTokens(args.businessId);
  const hint = args.hint ?? existing?.email;

  const token = await requestGisAccessToken({
    clientId: env.googleClientId,
    scope: DRIVE_FILE_SCOPE,
    prompt: args.prompt,
    hint,
  });

  if (!hasRequiredDriveScopes(token.scope)) {
    log.warn('connectDrive', 'Google did not grant required Drive scopes', {
      businessId: args.businessId,
      grantedScope: token.scope,
    });
    throw new Error(
      'Google account connected, but Drive permission was not granted. Choose Reconnect and approve the Google Drive access request.',
    );
  }

  const identity = await fetchUserInfo(token.accessToken);
  await saveTokens(
    args.businessId,
    {
      accessToken: token.accessToken,
      expiresAt: token.expiresAt,
      tokenType: 'Bearer',
      scope: token.scope,
    },
    { email: identity.email, sub: identity.sub },
  );
  log.info('connectDrive', 'connected', {
    businessId: args.businessId,
    email: identity.email,
  });

  return {
    accessToken: token.accessToken,
    expiresAt: token.expiresAt,
    identity,
  };
}

// Silent-only variant used by the DriveApiClient before every fetch when the
// stored token is near expiry. Never surfaces a popup — throws instead so the
// caller can decide whether to route the user to a Reconnect button.
export async function silentRefreshDrive(businessId: string): Promise<string> {
  if (!env.googleClientId) {
    throw new Error('Google Drive not configured (missing VITE_GOOGLE_CLIENT_ID)');
  }
  const existing = await loadTokens(businessId);
  const pending = silentRefreshes.get(businessId);
  if (pending) {
    log.debug('connectDrive', 'joining in-flight silent refresh', { businessId });
    return pending;
  }
  const refresh = (async (): Promise<string> => {
    const hint = existing?.email;
    log.info('connectDrive', 'silent refresh started', { businessId, hint });
    try {
      const token = await requestGisAccessToken({
        clientId: env.googleClientId,
        scope: DRIVE_FILE_SCOPE,
        prompt: '',
        hint,
      });
      await saveTokens(
        businessId,
        {
          accessToken: token.accessToken,
          expiresAt: token.expiresAt,
          tokenType: 'Bearer',
          scope: token.scope,
        },
        existing?.email && existing?.googleSub
          ? { email: existing.email, sub: existing.googleSub }
          : undefined,
      );
      log.info('connectDrive', 'silent refresh completed', { businessId });
      return token.accessToken;
    } catch (err) {
      log.warn('connectDrive', 'silent refresh failed', { businessId, error: err });
      throw err;
    } finally {
      silentRefreshes.delete(businessId);
    }
  })();
  silentRefreshes.set(businessId, refresh);
  return refresh;
}

export async function disconnectDrive(businessId: string): Promise<void> {
  const existing = await loadTokens(businessId);
  if (existing?.accessToken) {
    await revokeGisToken(existing.accessToken).catch((err) => {
      log.warn('connectDrive', 'revoke failed (proceeding)', { error: err });
    });
  }
  await clearTokens(businessId);
  log.info('connectDrive', 'disconnected', { businessId });
}

export async function isDriveConnected(businessId: string): Promise<boolean> {
  const rec = await loadTokens(businessId);
  return !!rec?.accessToken;
}

export async function getConnectedEmail(businessId: string): Promise<string | null> {
  const rec = await loadTokens(businessId);
  return rec?.email ?? null;
}
