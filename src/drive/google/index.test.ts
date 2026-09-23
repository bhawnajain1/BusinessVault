import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDriveApiClient } from './index';
import { resetTokenDb, saveTokens } from '../tokenStore';

const businessId = 'google-retry-test';

afterEach(() => {
  vi.restoreAllMocks();
  resetTokenDb();
});

async function seedToken(): Promise<void> {
  await saveTokens(businessId, {
    accessToken: 'test-token',
    expiresAt: Date.now() + 60 * 60 * 1000,
    tokenType: 'Bearer',
  });
}

describe('GIS Drive client transient GET failures', () => {
  it('retries a Drive GET after a transient 500 and returns the successful response', async () => {
    await seedToken();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('internal error', { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ email: 'owner@example.com' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const request = createDriveApiClient({ businessId }).getUserInfo();

    await expect(request).resolves.toEqual({
      emailAddress: 'owner@example.com',
      displayName: undefined,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a transient failure for a mutating request', async () => {
    await seedToken();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('internal error', { status: 500 }));

    const client = createDriveApiClient({ businessId });
    await expect(
      client.createFile({
        parentId: 'parent',
        name: 'file.txt',
        mimeType: 'text/plain',
        body: new Blob(['content']),
      }),
    ).rejects.toThrow('HTTP 500');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
