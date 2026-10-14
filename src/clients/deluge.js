// -----------------------------------------------------------------------------
// Deluge client, through the JSON-RPC of its web interface (deluge-web, port
// 8112): POST /json with `{ method, params, id }`.
//
// Session: auth.login with the web interface password ("deluge" until
// changed) answers true and a `_session_id` cookie; a call without a valid
// session answers the error code 1 "Not authenticated": the client logs in
// again once and retries. The web interface must be connected to a daemon
// (deluged): when it is not, the client connects it to the first daemon it
// knows (the Connection Manager list), as the web interface itself does with
// "default_daemon".
//
// Reading: web.update_ui with only the torrent fields used (payload speeds,
// free space of the download folder included). Deluge has no alternative
// speed mode: the switch is not offered on Deluge devices.
// -----------------------------------------------------------------------------

import { httpRequest } from './http.js';
import {
  ClientError,
  ERROR_KINDS,
  LoginGuard,
  cookieHeader,
  epochMs,
  magnetHash,
  networkError,
  parseJson,
  statusError,
  storeCookies,
} from './common.js';

const TORRENT_KEYS = [
  'name',
  'state',
  'progress',
  'download_payload_rate',
  'all_time_download',
  'total_wanted',
  'time_added',
  'label',
];

const NOT_AUTHENTICATED = 1;

/** The JSON-RPC address: the path typed is kept, `/json` added when missing. */
export function jsonUrl(url) {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${/\/json$/.test(path) ? path : `${path}/json`}`;
}

/** One torrent of web.update_ui, in the shape of src/model.js. */
export function toTorrent(hash, raw) {
  const state = String(raw.state ?? '');
  // A magnet link without its metadata yet wants 0 bytes.
  const hasMetadata = Number(raw.total_wanted) > 0;
  const progress =
    typeof raw.progress === 'number' ? Math.min(1, Math.max(0, raw.progress / 100)) : 0;
  return {
    hash,
    name: typeof raw.name === 'string' && raw.name ? raw.name : hash,
    progress,
    paused: state === 'Paused',
    checking: ['Checking', 'Allocating', 'Moving'].includes(state),
    downloading: state === 'Downloading',
    error: state === 'Error',
    hasMetadata,
    complete: hasMetadata && progress >= 1,
    downloadSpeed: Number(raw.download_payload_rate) || 0,
    downloaded: Number(raw.all_time_download) || 0,
    size: hasMetadata ? Number(raw.total_wanted) : null,
    category: typeof raw.label === 'string' && raw.label ? raw.label : null,
    addedAt: epochMs(raw.time_added),
  };
}

export class DelugeClient {
  /**
   * @param {object} options
   * @param {string} options.url base URL (src/config.js parseClientUrl)
   * @param {string} [options.password] web interface password
   * @param {boolean} [options.insecure]
   * @param {typeof httpRequest} [options.request] test seam
   * @param {() => number} [options.now]
   */
  constructor({ url, password = '', insecure = false, request = httpRequest, now = Date.now }) {
    this.url = jsonUrl(url);
    this.password = password;
    this.insecure = insecure;
    this.request = request;
    this.cookies = new Map();
    this.guard = new LoginGuard(now);
    this.loggedIn = false;
    this.loggingIn = null;
    this.nextId = 1;
    this.version = null;
    this.supportsAltSpeed = false;
  }

  async send(method, params) {
    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    if (this.cookies.size > 0) {
      headers.cookie = cookieHeader(this.cookies);
    }
    let response;
    try {
      response = await this.request(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ method, params, id: this.nextId++ }),
        insecure: this.insecure,
      });
    } catch (err) {
      throw networkError(err);
    }
    if (response.status !== 200) {
      throw statusError(response, method);
    }
    storeCookies(this.cookies, response.headers);
    const data = parseJson(response.body);
    if (!data || typeof data !== 'object' || !('result' in data) || !('error' in data)) {
      throw new ClientError(ERROR_KINDS.NOT_FOUND, `${method}: not a Deluge answer`);
    }
    return data;
  }

  /** One login at a time: concurrent requests share it. */
  login(options = {}) {
    this.loggingIn ??= this.doLogin(options).finally(() => {
      this.loggingIn = null;
    });
    return this.loggingIn;
  }

  async doLogin({ force = false } = {}) {
    this.guard.check(force);
    const data = await this.send('auth.login', [this.password]);
    if (data.result !== true) {
      const error = new ClientError(ERROR_KINDS.AUTH, 'Password refused');
      this.guard.failed(error);
      throw error;
    }
    this.guard.succeeded();
    this.loggedIn = true;
  }

  /** A call that logs in first, and again once on "Not authenticated". */
  async call(method, params = [], options = {}) {
    if (!this.loggedIn) {
      await this.login(options);
    }
    let data = await this.send(method, params);
    if (data.error?.code === NOT_AUTHENTICATED) {
      this.loggedIn = false;
      this.cookies.clear();
      await this.login(options);
      data = await this.send(method, params);
    }
    if (data.error) {
      const message = String(data.error.message ?? 'error').slice(0, 160);
      throw new ClientError(ERROR_KINDS.REJECTED, `${method}: ${message}`);
    }
    return data.result;
  }

  /** Connect the web interface to its first daemon when it is not. */
  async connectDaemon(options) {
    if (await this.call('web.connected', [], options)) {
      return;
    }
    const hosts = await this.call('web.get_hosts', [], options);
    if (!Array.isArray(hosts) || hosts.length === 0 || !Array.isArray(hosts[0])) {
      throw new ClientError(ERROR_KINDS.NO_DAEMON, 'No daemon in the Connection Manager');
    }
    try {
      await this.call('web.connect', [hosts[0][0]], options);
    } catch (err) {
      if (err.kind === ERROR_KINDS.REJECTED) {
        throw new ClientError(ERROR_KINDS.NO_DAEMON, 'The daemon refuses the connection');
      }
      throw err;
    }
    if (!(await this.call('web.connected', [], options))) {
      throw new ClientError(ERROR_KINDS.NO_DAEMON, 'The daemon does not answer');
    }
    this.version = null;
  }

  /** @returns {Promise<object>} a reading, in the shape of src/model.js */
  async read({ force = false } = {}) {
    const options = { force };
    let ui = await this.call('web.update_ui', [TORRENT_KEYS, {}], options);
    if (!ui?.connected) {
      await this.connectDaemon(options);
      ui = await this.call('web.update_ui', [TORRENT_KEYS, {}], options);
      if (!ui?.connected) {
        throw new ClientError(ERROR_KINDS.NO_DAEMON, 'The daemon does not answer');
      }
    }
    if (this.version === null) {
      const version = await this.call('daemon.get_version', [], options).catch(() => null);
      this.version = typeof version === 'string' ? version : null;
    }
    const stats = ui.stats ?? {};
    const free = Number(stats.free_space);
    return {
      version: this.version,
      downloadSpeed: Number(stats.download_rate) || 0,
      uploadSpeed: Number(stats.upload_rate) || 0,
      freeSpace: Number.isFinite(free) && free >= 0 ? free : null,
      altSpeed: null,
      torrents: Object.entries(ui.torrents ?? {}).map(([hash, raw]) => toTorrent(hash, raw)),
    };
  }

  async torrentIds() {
    const torrents = await this.call('core.get_torrents_status', [{}, ['name']]);
    return Object.keys(torrents ?? {});
  }

  // core.pause_torrent takes a list in Deluge 1.3 and 2.x alike.
  async pauseAll() {
    const ids = await this.torrentIds();
    if (ids.length > 0) {
      await this.call('core.pause_torrent', [ids]);
    }
  }

  async resumeAll() {
    const ids = await this.torrentIds();
    if (ids.length > 0) {
      await this.call('core.resume_torrent', [ids]);
    }
  }

  async setAltSpeed() {
    throw new ClientError(ERROR_KINDS.UNSUPPORTED, 'Deluge has no alternative speed mode');
  }

  /** @returns {Promise<{ hash: string }>} */
  async addMagnet(uri) {
    const hash = magnetHash(uri);
    if (!hash) {
      throw new ClientError(ERROR_KINDS.REJECTED, 'Not a magnet link');
    }
    const id = await this.call('core.add_torrent_magnet', [uri, {}]);
    return { hash: typeof id === 'string' && id ? id : hash };
  }

  async logout() {
    if (!this.loggedIn) {
      return;
    }
    this.loggedIn = false;
    await this.send('auth.delete_session', []).catch(() => {});
    this.cookies.clear();
  }
}
