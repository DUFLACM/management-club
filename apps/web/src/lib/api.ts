/**
 * 统一 API 客户端。
 *
 * - 同域 Cookie 会话：所有请求 credentials: 'include'；
 * - 统一前缀 /api/v1（开发环境由 Vite 代理到 http://localhost:8080）；
 * - 响应为 `{ data, meta }` 包络（meta: requestId / nextCursor / revision）；
 * - 错误抛 ApiError（稳定 errorCode + message）；
 * - 401 时派发全局事件 'club:unauthorized'，由路由/壳层处理会话过期；
 * - CSRF：非 GET 请求先 GET /auth/csrf 取 token（模块级内存保存），
 *   随请求头 X-Clubs-Csrf 发送。
 */

export const API_BASE = '/api/v1';
export const UNAUTHORIZED_EVENT = 'club:unauthorized';
export const CSRF_HEADER = 'X-Clubs-Csrf';

export class ApiError extends Error {
  /** 后端稳定错误码，如 AUTH_REQUIRED、INVITE_INVALID */
  readonly code: string;
  readonly status: number;
  readonly requestId?: string;

  constructor(
    code: string,
    message: string,
    options?: { status?: number; requestId?: string; cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'ApiError';
    this.code = code;
    this.status = options?.status ?? 0;
    this.requestId = options?.requestId;
  }
}

export interface ResponseMeta {
  requestId?: string;
  nextCursor?: string | null;
  revision?: string;
  [key: string]: unknown;
}

export interface Envelope<T> {
  data: T;
  meta: ResponseMeta | null;
}

let csrfToken: string | null = null;

interface CsrfPayload {
  token?: string;
  csrfToken?: string;
}

/** 拉取并缓存 CSRF token（匿名绑定或会话绑定，均 no-store）。 */
export async function fetchCsrfToken(): Promise<string | null> {
  if (csrfToken) return csrfToken;
  const response = await fetch(`${API_BASE}/auth/csrf`, {
    method: 'GET',
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) return null;
  const body = (await response.json()) as unknown;
  const payload = (body && typeof body === 'object' && 'data' in body
    ? (body as { data?: CsrfPayload }).data
    : (body as CsrfPayload | null)) ?? null;
  csrfToken = payload?.csrfToken ?? payload?.token ?? null;
  return csrfToken;
}

/** 会话轮换（登录/登出）后调用，使缓存的 CSRF token 失效。 */
export function resetCsrfToken(): void {
  csrfToken = null;
}

interface ErrorBody {
  errorCode?: string;
  code?: string;
  message?: string;
  requestId?: string;
  error?: {
    errorCode?: string;
    code?: string;
    message?: string;
    requestId?: string;
  };
}

function readErrorCode(body: ErrorBody | null, status: number): string {
  if (body?.errorCode) return body.errorCode;
  if (body?.code) return body.code;
  if (status === 401) return 'AUTH_REQUIRED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status >= 500) return 'INTERNAL_ERROR';
  return 'REQUEST_FAILED';
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** JSON 请求体（自动序列化并设置 Content-Type） */
  body?: unknown;
  /** 额外请求头 */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** 跳过 CSRF（仅内部 GET /auth/csrf 使用） */
  skipCsrf?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<Envelope<T>> {
  const method = options.method ?? 'GET';
  const headers = new Headers({ Accept: 'application/json', ...options.headers });

  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }

  if (method !== 'GET' && !options.skipCsrf) {
    const token = await fetchCsrfToken();
    if (token) headers.set(CSRF_HEADER, token);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: 'include',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (cause) {
    throw new ApiError('NETWORK_ERROR', '网络请求失败，请检查网络连接后重试。', {
      cause,
    });
  }

  if (response.status === 204) {
    return { data: null as T, meta: null };
  }

  let body: unknown = null;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    body = await response.json().catch(() => null);
  }

  if (!response.ok) {
    const errorEnvelope = (body ?? {}) as ErrorBody;
    const errorBody = errorEnvelope.error ?? errorEnvelope;
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    }
    throw new ApiError(
      readErrorCode(errorBody, response.status),
      errorBody.message ?? '请求失败，请稍后重试。',
      { status: response.status, requestId: errorBody.requestId ?? errorEnvelope.requestId },
    );
  }

  const envelope = body as Partial<Envelope<T>> | null;
  return {
    data: (envelope && 'data' in envelope ? envelope.data : (body as T)) ?? (null as T),
    meta: (envelope?.meta as ResponseMeta | undefined) ?? null,
  };
}

export const api = {
  request,
  async get<T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) {
    return request<T>(path, { ...options, method: 'GET' });
  },
  async post<T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) {
    return request<T>(path, { ...options, method: 'POST', body });
  },
  async patch<T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) {
    return request<T>(path, { ...options, method: 'PATCH', body });
  },
  async put<T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) {
    return request<T>(path, { ...options, method: 'PUT', body });
  },
  async delete<T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) {
    return request<T>(path, { ...options, method: 'DELETE' });
  },
  /** multipart 文件上传：浏览器自动设置 boundary，手动 JSON 序列化会破坏表单 */
  async upload<T>(path: string, form: FormData): Promise<Envelope<T>> {
    const headers = new Headers({ Accept: 'application/json' });
    const token = await fetchCsrfToken();
    if (token) headers.set(CSRF_HEADER, token);
    let response: Response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: form,
      });
    } catch (cause) {
      throw new ApiError('NETWORK_ERROR', '网络请求失败，请检查网络连接后重试。', { cause });
    }
    let body: unknown = null;
    if ((response.headers.get('content-type') ?? '').includes('application/json')) {
      body = await response.json().catch(() => null);
    }
    if (!response.ok) {
      const errorEnvelope = (body ?? {}) as ErrorBody;
      const errorBody = errorEnvelope.error ?? errorEnvelope;
      if (response.status === 401) {
        window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
      }
      throw new ApiError(
        readErrorCode(errorBody, response.status),
        errorBody.message ?? '上传失败，请稍后重试。',
        { status: response.status, requestId: errorBody.requestId ?? errorEnvelope.requestId },
      );
    }
    const envelope = body as Partial<Envelope<T>> | null;
    return {
      data: (envelope && 'data' in envelope ? envelope.data : (body as T)) ?? (null as T),
      meta: (envelope?.meta as ResponseMeta | undefined) ?? null,
    };
  },
};
