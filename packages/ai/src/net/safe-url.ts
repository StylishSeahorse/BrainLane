/**
 * SSRF guard for user-supplied provider endpoints.
 *
 * Letting someone type a base URL means the server will make an outbound
 * request to whatever they name. On a cloud host that is a direct line to the
 * instance metadata service (169.254.169.254) and to anything else reachable on
 * the private network — the classic path from "custom AI endpoint" to leaked
 * cloud credentials.
 *
 * Three defences, because each one alone is bypassable:
 *
 *   1. Scheme and shape: https only, except an explicit localhost opt-in for
 *      people running Ollama on their own machine.
 *   2. Literal address rejection: an IP in a private, loopback, link-local or
 *      reserved range is refused outright.
 *   3. Resolve-then-pin: a hostname is resolved *here*, every returned address
 *      is checked, and the request is then made against the pinned IP. Without
 *      this, a name that passes validation can resolve to 169.254.169.254 a
 *      moment later — DNS rebinding, and checking the hostname alone does
 *      nothing to stop it.
 *
 * This module is pure and testable; `pinnedFetch` is the only part that does
 * I/O.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class UnsafeEndpointError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'UnsafeEndpointError';
  }
}

/** Hostnames we accept over plain http, for local self-hosted models. */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Is this IPv4 address in a range that must never be reachable from a
 * user-supplied URL?
 */
function isBlockedIPv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true; // Unparseable is not safe.
  }

  const [a = 0, b = 0] = parts;

  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast, reserved, broadcast

  return false;
}

function isBlockedIPv6(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, '');

  if (value === '::' || value === '::1') return true; // unspecified, loopback
  if (value.startsWith('fe80')) return true; // link-local
  if (value.startsWith('fc') || value.startsWith('fd')) return true; // unique local
  if (value.startsWith('ff')) return true; // multicast

  // IPv4-mapped (::ffff:a.b.c.d) inherits the IPv4 rules — otherwise
  // ::ffff:169.254.169.254 walks straight past the v6 checks.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped?.[1]) return isBlockedIPv4(mapped[1]);

  return false;
}

export function isBlockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isBlockedIPv4(address);
  if (version === 6) return isBlockedIPv6(address);
  return true; // Not an IP literal at all.
}

export interface SafeUrlOptions {
  /** Permit http://localhost — for locally hosted models such as Ollama. */
  allowLocalhost?: boolean;
}

/**
 * Validate the *shape* of an endpoint URL.
 *
 * Cheap, synchronous, and safe to run on every form submission. It does not
 * resolve DNS — that happens at request time in `pinnedFetch`, because a name
 * that is safe now can point somewhere else by the time we connect.
 */
export function assertSafeEndpoint(raw: string, options: SafeUrlOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeEndpointError('That is not a valid URL.', 'malformed');
  }

  const isLocal = LOCAL_HOSTNAMES.has(url.hostname.toLowerCase());

  if (url.protocol !== 'https:') {
    // http is tolerated only for an explicit local endpoint. Anywhere else it
    // means the API key would cross the network in clear text.
    if (!(url.protocol === 'http:' && isLocal && options.allowLocalhost)) {
      throw new UnsafeEndpointError(
        'Endpoints must use https, except a local endpoint on localhost.',
        'scheme',
      );
    }
  }

  if (url.username || url.password) {
    throw new UnsafeEndpointError('Credentials in the URL are not supported.', 'embedded-credentials');
  }

  if (isLocal) {
    if (!options.allowLocalhost) {
      throw new UnsafeEndpointError(
        'This provider cannot point at localhost.',
        'localhost-not-allowed',
      );
    }
    return url;
  }

  // A literal IP is checked immediately; a hostname is checked after
  // resolution, at request time.
  if (isIP(url.hostname) && isBlockedAddress(url.hostname)) {
    throw new UnsafeEndpointError(
      'That address is on a private or reserved network and cannot be used.',
      'blocked-address',
    );
  }

  return url;
}

/**
 * Fetch with the host resolved and pinned.
 *
 * The hostname is resolved here, every candidate address is validated, and the
 * connection is made to the address we checked — closing the window where DNS
 * changes between validation and connection. Redirects are never followed: a
 * 302 to the metadata service would otherwise undo all of the above.
 */
export async function pinnedFetch(
  url: URL,
  init: RequestInit & { timeoutMs?: number },
  options: SafeUrlOptions = {},
): Promise<Response> {
  const { timeoutMs = 30_000, ...rest } = init;

  const isLocal = LOCAL_HOSTNAMES.has(url.hostname.toLowerCase());

  // Re-checked here, not just in `assertSafeEndpoint`. This function is
  // reachable on its own, and a loopback URL must not bypass the guard simply
  // because it never goes through DNS resolution below.
  if (isLocal && !options.allowLocalhost) {
    throw new UnsafeEndpointError(
      'This provider cannot point at localhost.',
      'localhost-not-allowed',
    );
  }

  // A literal IP never goes through DNS, so it must be checked here too.
  // Without this, http://169.254.169.254 reaches `fetch` untouched whenever
  // `pinnedFetch` is called without validation having run first.
  if (!isLocal && isIP(url.hostname) && isBlockedAddress(url.hostname)) {
    throw new UnsafeEndpointError(
      'That address is on a private or reserved network and cannot be used.',
      'blocked-address',
    );
  }

  if (!isLocal && !isIP(url.hostname)) {
    let addresses: Array<{ address: string }>;
    try {
      addresses = await lookup(url.hostname, { all: true });
    } catch {
      throw new UnsafeEndpointError(`Could not resolve ${url.hostname}.`, 'dns-failure');
    }

    if (addresses.length === 0) {
      throw new UnsafeEndpointError(`Could not resolve ${url.hostname}.`, 'dns-empty');
    }

    // Every address must be safe, not merely the first. A host that returns one
    // public and one private address would otherwise be usable as a bypass.
    for (const { address } of addresses) {
      if (isBlockedAddress(address)) {
        throw new UnsafeEndpointError(
          `${url.hostname} resolves to a private or reserved address.`,
          'blocked-resolution',
        );
      }
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...rest,
      redirect: 'error',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
