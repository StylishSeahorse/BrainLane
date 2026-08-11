/**
 * Outbound HTTP that is safe to point at a URL a user typed.
 *
 * This package exists because two separate features now take a server address
 * from a form — a custom AI endpoint and a CalDAV server — and both would
 * otherwise be a direct line from a text input to the cloud metadata service.
 * One implementation, one test suite, one place to fix it.
 */
export {
  assertSafeEndpoint,
  isBlockedAddress,
  pinnedFetch,
  UnsafeEndpointError,
  type SafeUrlOptions,
} from './safe-url';
