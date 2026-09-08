import { Logger } from '@nestjs/common';
import { OandaApiError } from './oanda.error-mapper';

/** HTTP verbs used by the OANDA v20 REST surface this adapter covers. */
export type OandaHttpMethod = 'GET' | 'POST' | 'PUT';

/**
 * OANDA v20 REST base URLs (official, environment-separated — never crossed):
 * - DEMO (practice): https://api-fxpractice.oanda.com
 * - LIVE (trade):    https://api-fxtrade.oanda.com
 */
export const OANDA_DEFAULT_DEMO_BASE_URL = 'https://api-fxpractice.oanda.com';
export const OANDA_DEFAULT_LIVE_BASE_URL = 'https://api-fxtrade.oanda.com';

/**
 * Injectable transport for the OANDA v20 REST API (Directive §AN / §P).
 *
 * ENVIRONMENT ROUTING is owned by the ADAPTER: it resolves the
 * mode-specific base URL (DEMO practice vs LIVE trade) and passes it per
 * request, so a scripted transport records exactly which environment was
 * addressed (contract suite §AN-4). The bearer token travels in the
 * headers — the transport is the ONLY authorized channel for it.
 */
export interface OandaTransport {
  /**
   * @param method  HTTP verb
   * @param baseUrl mode-specific environment base URL chosen by the adapter
   * @param path    v3 API path (e.g. "/v3/accounts/{id}/summary")
   * @param headers auth/content headers (Authorization: Bearer <token>)
   * @param body    optional JSON-serializable request body
   */
  request<T>(
    method: OandaHttpMethod,
    baseUrl: string,
    path: string,
    headers: Record<string, string>,
    body?: unknown,
  ): Promise<T>;
}

/** Parsed v20 error body (some endpoints use `message`, others `errorMessage`). */
export interface OandaErrorBody {
  code?: string;
  message?: string;
  errorMessage?: string;
  requestId?: string;
  [key: string]: unknown;
}

/**
 * Default transport implementation using the global `fetch` API.
 *
 * - Non-2xx responses are parsed into `OandaApiError` (status + provider
 *   code + message + requestId + raw body) so the error mapper can map them.
 * - Network-level failures (DNS/TCP/TLS/abort) propagate as the raw
 *   underlying error — the adapter's error mapper classifies them
 *   (timeout vs provider unavailable). The raw error never contains the
 *   token because the token only ever lives in request headers.
 */
export class FetchOandaTransport implements OandaTransport {
  private readonly logger = new Logger(FetchOandaTransport.name);

  constructor(private readonly requestTimeoutMs: number = 10_000) {}

  async request<T>(
    method: OandaHttpMethod,
    baseUrl: string,
    path: string,
    headers: Record<string, string>,
    body?: unknown,
  ): Promise<T> {
    const url = `${baseUrl}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: { ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: this.requestTimeoutMs > 0 ? AbortSignal.timeout(this.requestTimeoutMs) : undefined,
      });
    } catch (err) {
      // Network-level failure — no HTTP status exists. Propagate the raw
      // error (TimeoutError/AbortError classify as CONNECTION_TIMEOUT).
      this.logger.warn(
        `OANDA transport request failed: ${method} ${path} (${(err as Error).name})`,
      );
      throw err;
    }

    const text = await response.text();
    let parsed: OandaErrorBody | undefined;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text) as OandaErrorBody;
      } catch {
        parsed = undefined;
      }
    }

    if (!response.ok) {
      const providerCode = typeof parsed?.code === 'string' ? parsed.code : '';
      const providerMessage =
        parsed?.errorMessage ?? parsed?.message ?? (text.length > 0 ? text.slice(0, 200) : '');
      throw new OandaApiError(
        response.status,
        providerCode,
        typeof providerMessage === 'string' ? providerMessage : String(providerMessage),
        typeof parsed?.requestId === 'string' ? parsed.requestId : undefined,
        parsed,
      );
    }

    return parsed as T;
  }
}
