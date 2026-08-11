import { describe, expect, it } from 'vitest';
import { assertSafeEndpoint, isBlockedAddress, pinnedFetch, UnsafeEndpointError } from './safe-url';

describe('isBlockedAddress', () => {
  it('blocks the cloud metadata endpoint', () => {
    // The single most valuable SSRF target on a cloud host.
    expect(isBlockedAddress('169.254.169.254')).toBe(true);
  });

  it('blocks loopback, private and reserved IPv4 ranges', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.4.1',
      '172.31.255.255',
      '192.168.1.1',
      '0.0.0.0',
      '100.64.0.1',
      '224.0.0.1',
      '255.255.255.255',
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it('allows ordinary public IPv4', () => {
    for (const address of ['1.1.1.1', '8.8.8.8', '104.18.32.7', '172.15.0.1', '172.32.0.1']) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it('blocks IPv6 loopback, link-local and unique-local', () => {
    for (const address of ['::1', '::', 'fe80::1', 'fd00::1', 'fc00::1', 'ff02::1']) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it('blocks IPv4-mapped IPv6 that hides a private address', () => {
    // ::ffff:169.254.169.254 must not slip past the v6 checks.
    expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true);
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('treats anything that is not an IP as unsafe', () => {
    for (const value of ['', 'not-an-ip', '999.999.999.999', '10.0.0']) {
      expect(isBlockedAddress(value), value).toBe(true);
    }
  });
});

describe('assertSafeEndpoint', () => {
  it('accepts a normal https endpoint', () => {
    expect(assertSafeEndpoint('https://api.openai.com/v1').hostname).toBe('api.openai.com');
  });

  it('rejects http for remote hosts, so the key is never sent in clear text', () => {
    expect(() => assertSafeEndpoint('http://api.example.com/v1')).toThrow(UnsafeEndpointError);
  });

  it('rejects other schemes outright', () => {
    for (const raw of ['file:///etc/passwd', 'ftp://example.com', 'gopher://example.com']) {
      expect(() => assertSafeEndpoint(raw), raw).toThrow(UnsafeEndpointError);
    }
  });

  it('rejects a literal private or metadata address', () => {
    for (const raw of [
      'https://169.254.169.254/latest/meta-data/',
      'https://127.0.0.1:8080/v1',
      'https://10.0.0.1/v1',
      'https://192.168.0.10/v1',
    ]) {
      expect(() => assertSafeEndpoint(raw), raw).toThrow(UnsafeEndpointError);
    }
  });

  it('rejects credentials embedded in the URL', () => {
    expect(() => assertSafeEndpoint('https://user:pass@api.example.com/v1')).toThrow(
      /credentials/i,
    );
  });

  it('rejects malformed input rather than guessing', () => {
    for (const raw of ['', 'not a url', 'https://']) {
      expect(() => assertSafeEndpoint(raw), raw).toThrow(UnsafeEndpointError);
    }
  });

  describe('localhost', () => {
    it('is allowed only when the provider opts in', () => {
      expect(
        assertSafeEndpoint('http://localhost:11434/v1', { allowLocalhost: true }).port,
      ).toBe('11434');

      expect(() => assertSafeEndpoint('http://localhost:11434/v1')).toThrow(
        /localhost/i,
      );
    });

    it('accepts the loopback spellings people actually type', () => {
      for (const raw of ['http://localhost:11434/v1', 'http://127.0.0.1:11434/v1']) {
        expect(() => assertSafeEndpoint(raw, { allowLocalhost: true }), raw).not.toThrow();
      }
    });
  });

  it('carries a machine-readable reason for every refusal', () => {
    try {
      assertSafeEndpoint('https://169.254.169.254/');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeEndpointError);
      expect((error as UnsafeEndpointError).reason).toBe('blocked-address');
      // The message is shown to a user, so it has to read as a sentence.
      expect((error as UnsafeEndpointError).message).toMatch(/[a-z]{4,}\s+[a-z]{2,}/i);
    }
  });
});

describe('pinnedFetch guards independently of assertSafeEndpoint', () => {
  it('refuses localhost when the provider has not opted in', async () => {
    // Reachable on its own, so it cannot rely on validation having run first.
    await expect(
      pinnedFetch(new URL('http://localhost:11434/v1/models'), {}, { allowLocalhost: false }),
    ).rejects.toThrow(/localhost/i);
  });

  it('refuses a literal private address before making any request', async () => {
    await expect(
      pinnedFetch(new URL('http://169.254.169.254/latest/meta-data/'), {}, {}),
    ).rejects.toThrow(UnsafeEndpointError);
  });
});
