import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('API error envelopes', () => {
  it('preserves the backend stable error code, reason and request ID', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: 'RULE_GAP',
        message: 'R01 月度取整口径未决，正式结算已阻塞',
        requestId: 'request-r01',
      },
    }), { status: 422, headers: { 'Content-Type': 'application/json' } })));

    await expect(api.get('/admin/scoring-batches')).rejects.toMatchObject({
      name: 'ApiError',
      code: 'RULE_GAP',
      message: 'R01 月度取整口径未决，正式结算已阻塞',
      requestId: 'request-r01',
      status: 422,
    });
  });

  it('continues to accept a flat error response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      errorCode: 'WINDOW_CLOSED',
      message: 'IN 窗口未开放',
      requestId: 'request-in',
    }), { status: 400, headers: { 'Content-Type': 'application/json' } })));

    await expect(api.get('/activities/example/attendance-context')).rejects.toMatchObject({
      code: 'WINDOW_CLOSED',
      message: 'IN 窗口未开放',
      requestId: 'request-in',
    });
  });

  it('uses the HTTP status when the response has no stable code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));

    const error = await api.get('/me/dashboard').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'INTERNAL_ERROR', status: 503 });
  });
});
