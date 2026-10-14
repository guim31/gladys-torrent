// -----------------------------------------------------------------------------
// Transmission RPC client (the JSON-RPC of transmission-daemon and of the
// desktop versions with remote access on; specified in docs/rpc-spec.md of
// the Transmission repository).
//
// Every call is a POST of `{ method, arguments }` to /transmission/rpc
// (`rpc-url` in settings.json), with HTTP basic authentication when the RPC
// requires it. CSRF protection: the first request answers 409 with an
// X-Transmission-Session-Id header, to send back on every request; it
// changes when the daemon restarts (a new 409, handled the same way).
// A 403 means the address of Gladys is not on `rpc-whitelist`.
//
// Each reading is four small calls: session-get (version, alternative speed
// mode, download folder), session-stats (speeds), torrent-get with only the
// fields used, and free-space (RPC 15, Transmission 2.80) on the download
// folder.
// -----------------------------------------------------------------------------

import { httpRequest } from './http.js';
import {
  ClientError,
  ERROR_KINDS,
  LoginGuard,
  epochMs,
  magnetHash,
  networkError,
  parseJson,
  statusError,
} from './common.js';

const TORRENT_FIELDS = [
  'hashString',
  'name',
  'status',
  'percentDone',
  'metadataPercentComplete',
  'rateDownload',
  'downloadedEver',
  'sizeWhenDone',
  'error',
  'addedDate',
  'labels',
];

// torrent-get `status` (RPC 14 and later).
export const STATUS = Object.freeze({
  STOPPED: 0,
  CHECK_WAIT: 1,
  CHECK: 2,
  DOWNLOAD_WAIT: 3,
  DOWNLOAD: 4,
  SEED_WAIT: 5,
  SEED: 6,
});

/** The RPC address: the path typed is kept, `/transmission/rpc` added when missing. */
export function rpcUrl(url) {
  const parsed = new URL(url);
  let path = parsed.pathname.replace(/\/+$/, '');
  if (/\/rpc$/.test(path)) {
    return `${parsed.origin}${path}`;
  }
  // The address of the web interface, copied from the browser.
  if (/\/web$/.test(path)) {
    return `${parsed.origin}${path.replace(/\/web$/, '/rpc')}`;
  }
  path = path.replace(/\/transmission$/, '');
  return `${parsed.origin}${path}/transmission/rpc`;
}

/** One torrent of torrent-get, in the shape of src/model.js. */
export function toTorrent(raw) {
  const hasMetadata = (raw.metadataPercentComplete ?? 1) >= 1;
  const progress =
    typeof raw.percentDone === 'number' ? Math.min(1, Math.max(0, raw.percentDone)) : 0;
  const hash = String(raw.hashString ?? raw.id);
  return {
    hash,
    name: typeof raw.name === 'string' && raw.name ? raw.name : hash,
    progress,
    paused: raw.status === STATUS.STOPPED,
    checking: raw.status === STATUS.CHECK || raw.status === STATUS.CHECK_WAIT,
    downloading: raw.status === STATUS.DOWNLOAD,
    error: typeof raw.error === 'number' && raw.error >= 3, // 1-2: tracker warnings/errors
    hasMetadata,
    complete: hasMetadata && progress >= 1,
    downloadSpeed: Number(raw.rateDownload) || 0,
    downloaded: Number(raw.downloadedEver) || 0,
    size: Number(raw.sizeWhenDone) > 0 ? Number(raw.sizeWhenDone) : null,
    category: Array.isArray(raw.labels) && raw.labels.length > 0 ? String(raw.labels[0]) : null,
    addedAt: epochMs(raw.addedDate),
  };
}

export class TransmissionClient {
  /**
   * @param {object} options
   * @param {string} options.url base URL (src/config.js parseClientUrl)
   * @param {string} [options.username]
   * @param {string} [options.password]
   * @param {boolean} [options.insecure]
   * @param {typeof httpRequest} [options.request] test seam
   * @param {() => number} [options.now]
   */
  constructor({
    url,
    username = '',
    password = '',
    insecure = false,
    request = httpRequest,
    now = () => Date.now(),
  }) {
    this.url = rpcUrl(url);
    this.authorization =
      username || password
        ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
        : null;
    this.insecure = insecure;
    this.request = request;
    this.guard = new LoginGuard(now);
    this.sessionId = null;
    this.version = null;
    this.rpcVersion = null;
    this.supportsAltSpeed = true;
  }

  async send(payload) {
    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    if (this.authorization) {
      headers.authorization = this.authorization;
    }
    if (this.sessionId) {
      headers['x-transmission-session-id'] = this.sessionId;
    }
    try {
      return await this.request(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        insecure: this.insecure,
      });
    } catch (err) {
      throw networkError(err);
    }
  }

  async call(method, args = {}, { force = false } = {}) {
    this.guard.check(force);
    const payload = { method, arguments: args };
    let response = await this.send(payload);
    if (response.status === 409) {
      const id = response.headers?.['x-transmission-session-id'];
      if (!id) {
        throw new ClientError(ERROR_KINDS.NOT_FOUND, `${method}: 409 without session id`);
      }
      this.sessionId = String(id);
      response = await this.send(payload);
    }
    if (response.status === 401) {
      const error = new ClientError(ERROR_KINDS.AUTH, 'User name or password refused', {
        status: 401,
      });
      this.guard.failed(error);
      throw error;
    }
    if (response.status === 403) {
      throw new ClientError(ERROR_KINDS.FORBIDDEN, 'Address of Gladys not on rpc-whitelist', {
        status: 403,
      });
    }
    if (response.status !== 200) {
      throw statusError(response, method);
    }
    this.guard.succeeded();
    const data = parseJson(response.body);
    if (!data || typeof data.result !== 'string') {
      throw new ClientError(ERROR_KINDS.NOT_FOUND, `${method}: not a Transmission answer`);
    }
    if (data.result !== 'success') {
      throw new ClientError(ERROR_KINDS.REJECTED, `${method}: ${data.result.slice(0, 120)}`);
    }
    return data.arguments ?? {};
  }

  /** @returns {Promise<object>} a reading, in the shape of src/model.js */
  async read({ force = false } = {}) {
    const options = { force };
    const session = await this.call(
      'session-get',
      { fields: ['version', 'rpc-version', 'alt-speed-enabled', 'download-dir'] },
      options,
    );
    this.version =
      typeof session.version === 'string' ? session.version.replace(/\s*\(.*\)$/, '') : null;
    this.rpcVersion = Number(session['rpc-version']) || null;
    const [stats, list, free] = await Promise.all([
      this.call('session-stats', {}, options),
      this.call('torrent-get', { fields: TORRENT_FIELDS }, options),
      this.freeSpace(session['download-dir'], options),
    ]);
    return {
      version: this.version,
      downloadSpeed: Number(stats.downloadSpeed) || 0,
      uploadSpeed: Number(stats.uploadSpeed) || 0,
      freeSpace: free,
      altSpeed:
        typeof session['alt-speed-enabled'] === 'boolean' ? session['alt-speed-enabled'] : null,
      torrents: (Array.isArray(list.torrents) ? list.torrents : []).map(toTorrent),
    };
  }

  /** Free bytes in the download folder; null when the daemon cannot tell. */
  async freeSpace(path, options) {
    if (typeof path !== 'string' || !path || (this.rpcVersion ?? 0) < 15) {
      return null;
    }
    try {
      const answer = await this.call('free-space', { path }, options);
      const bytes = Number(answer['size-bytes']);
      return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
    } catch (err) {
      if (err.kind === ERROR_KINDS.REJECTED) {
        return null; // folder missing on the daemon side
      }
      throw err;
    }
  }

  async pauseAll() {
    await this.call('torrent-stop'); // no ids: every torrent
  }

  async resumeAll() {
    await this.call('torrent-start');
  }

  /** Alternative speed limits ("turtle mode") on or off. */
  async setAltSpeed(enabled) {
    await this.call('session-set', { 'alt-speed-enabled': enabled });
  }

  /** @returns {Promise<{ hash: string }>} */
  async addMagnet(uri) {
    const hash = magnetHash(uri);
    if (!hash) {
      throw new ClientError(ERROR_KINDS.REJECTED, 'Not a magnet link');
    }
    const answer = await this.call('torrent-add', { filename: uri });
    if (answer['torrent-duplicate']) {
      throw new ClientError(ERROR_KINDS.REJECTED, 'torrent-add: duplicate');
    }
    return { hash: answer['torrent-added']?.hashString ?? hash };
  }

  async logout() {
    // Stateless: nothing to close.
  }
}
