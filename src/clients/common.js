// -----------------------------------------------------------------------------
// What the three clients share: the error kinds (each has a text in
// src/texts.js), the classification of network errors, a minimal cookie jar
// (qBittorrent and Deluge keep their session in a cookie) and the login
// back-off that keeps a wrong password from getting Gladys banned.
// -----------------------------------------------------------------------------

export const ERROR_KINDS = Object.freeze({
  UNREACHABLE: 'unreachable', // no answer: down, wrong address, firewall
  TLS: 'tls', // the certificate does not verify (self-signed without the option)
  AUTH: 'auth', // wrong or missing user name or password
  BANNED: 'banned', // qBittorrent banned the address of Gladys after failed logins
  FORBIDDEN: 'forbidden', // Transmission refuses the address of Gladys (rpc-whitelist)
  NOT_FOUND: 'not_found', // something answers, not the API of the chosen software
  NO_DAEMON: 'no_daemon', // the Deluge web interface is not connected to a daemon
  UNSUPPORTED: 'unsupported', // the software cannot do what was asked
  REJECTED: 'rejected', // the software refused the command (e.g. the torrent exists)
  HTTP: 'http', // any other HTTP error
});

export class ClientError extends Error {
  /**
   * @param {string} kind one of ERROR_KINDS
   * @param {string} message English, for the logs (never contains a secret)
   * @param {object} [extra] { status }
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'ClientError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** A failed request (no HTTP answer) as a ClientError. */
export function networkError(err) {
  if (err instanceof ClientError) {
    return err;
  }
  if (TLS_CODES.has(err.code)) {
    return new ClientError(ERROR_KINDS.TLS, `Certificate refused (${err.code})`);
  }
  return new ClientError(ERROR_KINDS.UNREACHABLE, err.code ? `${err.code}` : err.message);
}

/** An unexpected HTTP status as a ClientError. */
export function statusError(response, what) {
  if (response.status === 404) {
    return new ClientError(ERROR_KINDS.NOT_FOUND, `${what}: HTTP 404`, { status: 404 });
  }
  return new ClientError(ERROR_KINDS.HTTP, `${what}: HTTP ${response.status}`, {
    status: response.status,
  });
}

export function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** Cookies set by a response, merged into `jar` (name → value). */
export function storeCookies(jar, headers) {
  const raw = headers?.['set-cookie'];
  for (const line of Array.isArray(raw) ? raw : raw ? [raw] : []) {
    const [pair] = String(line).split(';');
    const at = pair.indexOf('=');
    if (at > 0) {
      jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
  }
}

export const cookieHeader = (jar) =>
  [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');

// qBittorrent bans the address after 5 failed logins (one hour by default):
// a refused password is tried again later and later, never at every reading.
// A new password typed in the configuration makes a new client, without wait;
// "Test the connection" tries at once.
export const LOGIN_BACKOFF_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];

/** Tracks the failed logins of one client. */
export class LoginGuard {
  constructor(now) {
    this.now = now;
    this.failures = 0;
    this.error = null;
    this.retryAt = 0;
  }

  /** Throws the last login error while its back-off runs (unless forced). */
  check(force = false) {
    if (!force && this.error && this.now() < this.retryAt) {
      throw this.error;
    }
  }

  failed(error) {
    if ([ERROR_KINDS.AUTH, ERROR_KINDS.BANNED].includes(error.kind)) {
      this.error = error;
      this.retryAt =
        this.now() + LOGIN_BACKOFF_MS[Math.min(this.failures, LOGIN_BACKOFF_MS.length - 1)];
      this.failures += 1;
    }
  }

  succeeded() {
    this.failures = 0;
    this.error = null;
    this.retryAt = 0;
  }
}

/** Seconds since the epoch, as milliseconds; null when unknown. */
export const epochMs = (seconds) =>
  typeof seconds === 'number' && seconds > 0 ? Math.round(seconds * 1000) : null;

/**
 * The magnet links the integration accepts: `magnet:?` with a BitTorrent info
 * hash (v1 `btih`, v2 `btmh`). Never an http(s) URL: the client would fetch it.
 * @returns {string|null} the info hash (lower case), null when not a magnet
 */
export function magnetHash(uri) {
  if (typeof uri !== 'string' || uri.length > 8000 || !/^magnet:\?/i.test(uri.trim())) {
    return null;
  }
  const match = uri.match(/[?&]xt=urn:(?:btih|btmh):([a-z0-9]+)/i);
  return match ? match[1].toLowerCase() : null;
}

/** The `dn` (display name) of a magnet link, null when absent. */
export function magnetName(uri) {
  const match = uri.match(/[?&]dn=([^&]*)/i);
  if (!match) {
    return null;
  }
  try {
    return decodeURIComponent(match[1].replace(/\+/g, ' ')).trim() || null;
  } catch {
    return null;
  }
}
