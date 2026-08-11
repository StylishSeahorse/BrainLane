/**
 * The HTTP layer for CalDAV.
 *
 * A CalDAV server address is typed by the user, which makes it the most
 * dangerous input in the product: without care, a text field in Settings
 * becomes a way to make our server fetch `http://169.254.169.254/` and hand
 * back the response. Every request therefore goes through `@fluid/net`'s
 * resolve-then-pin fetch, and every redirect hop is re-validated rather than
 * followed by the runtime.
 *
 * The transport is injectable so the adapter's tests can run a complete CalDAV
 * conversation — discovery, sync report, conditional PUT — against a scripted
 * server with no network involved.
 */
import { assertSafeEndpoint, pinnedFetch, UnsafeEndpointError } from '@fluid/net';

export interface CalDavRequest {
  method: string;
  url: URL;
  body?: string;
  headers?: Record<string, string>;
}

export interface CalDavResponse {
  status: number;
  headers: Headers;
  body: string;
  /** Final URL, after any redirects — hrefs resolve relative to this. */
  url: URL;
}

export type CalDavTransport = (request: CalDavRequest) => Promise<CalDavResponse>;

export interface TransportOptions {
  /** Permit an http://localhost server, for someone running Radicale locally. */
  allowLocalhost?: boolean;
  timeoutMs?: number;
  /** Bodies larger than this are refused rather than buffered. */
  maxBodyBytes?: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

export function createTransport(options: TransportOptions = {}): CalDavTransport {
  const { allowLocalhost = false, timeoutMs = 30_000, maxBodyBytes = 8 * 1024 * 1024 } = options;

  return async function transport(request: CalDavRequest): Promise<CalDavResponse> {
    let url = request.url;
    let method = request.method;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      // Re-validated on every hop, not just the first. A server that redirects
      // to an internal address is exactly the attack this is here to stop.
      assertSafeEndpoint(url.toString(), { allowLocalhost });

      const response = await pinnedFetch(
        url,
        {
          method,
          ...(request.body === undefined ? {} : { body: request.body }),
          headers: {
            'user-agent': 'Fluid/0.1 (+caldav)',
            ...request.headers,
          },
          redirect: 'manual',
          timeoutMs,
        },
        { allowLocalhost },
      );

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location');
        if (!location) {
          throw new UnsafeEndpointError(
            'The server redirected without saying where to.',
            'redirect-no-location',
          );
        }

        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new UnsafeEndpointError('The server redirected to an invalid URL.', 'redirect-malformed');
        }

        // 303 is the one status that genuinely means "now GET this". Everything
        // else keeps the method, which matters: a PROPFIND that silently became
        // a GET would return a web page instead of a property list.
        if (response.status === 303) method = 'GET';

        url = next;
        continue;
      }

      const length = Number(response.headers.get('content-length') ?? '0');
      if (length > maxBodyBytes) {
        throw new Error(`CalDAV response is too large (${length} bytes).`);
      }

      const body = await response.text();
      if (body.length > maxBodyBytes) {
        throw new Error('CalDAV response is too large.');
      }

      return { status: response.status, headers: response.headers, body, url };
    }

    throw new UnsafeEndpointError('The server redirected too many times.', 'redirect-loop');
  };
}

/**
 * HTTP Basic credentials.
 *
 * Basic is what essentially every CalDAV server accepts, and it sends the
 * password on every request — which is only acceptable because the endpoint
 * validator refuses anything but https (or an explicit localhost).
 */
export function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}
