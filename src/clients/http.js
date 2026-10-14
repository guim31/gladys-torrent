// -----------------------------------------------------------------------------
// The one function that talks to the network: an HTTP(S) request on
// node:http / node:https. Not on fetch: fetch cannot accept the self-signed
// certificate of one client only (a NAS often serves HTTPS with one),
// node:https can, per request. (Adapted from guim31/gladys-pihole.)
//
// The clients take this function as a parameter: the tests replace it with
// in-memory torrent clients (test/helpers/fakeClients.js).
// -----------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';

// A first qBittorrent synchronization lists every torrent with ~50 fields:
// about 2 KB each, so 10 000 torrents fit.
export const MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * @param {string} url absolute URL
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {Record<string, string>} [options.headers]
 * @param {string|Buffer} [options.body] raw body (set its content-type in headers)
 * @param {boolean} [options.insecure] accept a certificate that does not verify (HTTPS only)
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ status: number, headers: Record<string, string|string[]>, body: string }>}
 */
export function httpRequest(
  url,
  { method = 'GET', headers = {}, body, insecure = false, timeoutMs = 15_000 } = {},
) {
  const target = new URL(url);
  const isHttps = target.protocol === 'https:';
  const payload = body === undefined ? undefined : Buffer.from(body);
  const requestHeaders = {
    ...headers,
    ...(payload ? { 'content-length': payload.length } : {}),
  };

  return new Promise((resolve, reject) => {
    const request = (isHttps ? https : http).request(
      target,
      {
        method,
        headers: requestHeaders,
        timeout: timeoutMs,
        ...(isHttps ? { rejectUnauthorized: !insecure } : {}),
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            request.destroy(new Error('Response too large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        response.on('error', reject);
      },
    );
    request.on('timeout', () => {
      const error = new Error(`Timed out after ${timeoutMs} ms`);
      error.code = 'ETIMEDOUT';
      request.destroy(error);
    });
    request.on('error', reject);
    request.end(payload);
  });
}
