// -----------------------------------------------------------------------------
// qBittorrent Web API v2 client (the API of the web interface, qBittorrent
// 4.1 and later; documented on the qBittorrent wiki, "WebUI API").
//
// Session: POST /api/v2/auth/login answers "Ok." and a session cookie (`SID`,
// renamed in recent versions: every cookie is kept and sent back), "Fails."
// for a wrong password, 403 once the address is banned (5 failed logins by
// default, for an hour). A request without a valid session answers 403: the
// client logs in again once and retries. "Bypass authentication for clients
// on localhost / in whitelisted IP subnets" makes the login useless: with no
// user name and no password, the client does not log in until a 403 asks.
// No Referer nor Origin header: qBittorrent's CSRF protection answers 401 to
// one whose host differs from the Host it sees, which a reverse proxy causes;
// without them, the check does not apply (qbittorrent-api stopped sending
// them for that reason, its issue #63).
//
// Reading: GET /api/v2/sync/maindata?rid=N answers what changed since the
// answer `rid` N (a full list when N is 0 or unknown): the client keeps the
// torrents in memory and merges the changes, so a library of thousands of
// seeding torrents costs a few hundred bytes per reading.
//
// qBittorrent 5.0 (Web API 2.11.0) renamed pause/resume to stop/start, and
// the states paused* to stopped*: both are handled.
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
  statusError,
  storeCookies,
  parseJson,
} from './common.js';

// The torrent fields the integration reads (the rest is dropped on arrival).
const FIELDS = [
  'name',
  'progress',
  'state',
  'dlspeed',
  'downloaded',
  'size',
  'total_size',
  'category',
  'added_on',
  'has_metadata',
];

const DOWNLOADING = new Set(['downloading', 'forcedDL', 'stalledDL', 'metaDL', 'forcedMetaDL']);
const CHECKING = new Set([
  'checkingDL',
  'checkingUP',
  'checkingResumeData',
  'allocating',
  'moving',
]);
const PAUSED = /^(paused|stopped)/;

/** Web API version "2.11.0" → [2, 11, 0]. */
const versionParts = (text) =>
  String(text ?? '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);

/** One torrent of the sync data, in the shape of src/model.js. */
export function toTorrent(hash, raw) {
  const state = String(raw.state ?? 'unknown');
  // `has_metadata` since Web API 2.10 (qBittorrent 5); before, the state and size tell.
  const hasMetadata =
    typeof raw.has_metadata === 'boolean'
      ? raw.has_metadata
      : !/metaDL$/i.test(state) && raw.total_size !== -1;
  const progress = typeof raw.progress === 'number' ? Math.min(1, Math.max(0, raw.progress)) : 0;
  return {
    hash,
    name: typeof raw.name === 'string' && raw.name ? raw.name : hash,
    progress,
    paused: PAUSED.test(state),
    checking: CHECKING.has(state),
    downloading: DOWNLOADING.has(state),
    error: state === 'error' || state === 'missingFiles',
    hasMetadata,
    complete: hasMetadata && progress >= 1,
    downloadSpeed: Number(raw.dlspeed) || 0,
    downloaded: Number(raw.downloaded) || 0,
    size: Number(raw.size) > 0 ? Number(raw.size) : null,
    category: typeof raw.category === 'string' && raw.category ? raw.category : null,
    addedAt: epochMs(raw.added_on),
  };
}

export class QbittorrentClient {
  /**
   * @param {object} options
   * @param {string} options.url base URL (src/config.js parseClientUrl)
   * @param {string} [options.username]
   * @param {string} [options.password]
   * @param {boolean} [options.insecure] accept a self-signed certificate
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
    this.base = url.replace(/\/api\/v2$/, '');
    this.username = username;
    this.password = password;
    this.insecure = insecure;
    this.request = request;
    this.cookies = new Map();
    this.guard = new LoginGuard(now);
    this.loggedIn = false;
    this.loggingIn = null;
    this.webApi = null;
    this.version = null;
    this.supportsAltSpeed = true;
    this.resetSync();
  }

  resetSync() {
    this.rid = 0;
    this.raw = new Map(); // hash → the FIELDS of the torrent
    this.server = {};
  }

  async send(path, { method = 'GET', form } = {}) {
    const headers = { accept: 'application/json, text/plain' };
    if (this.cookies.size > 0) {
      headers.cookie = cookieHeader(this.cookies);
    }
    let body;
    if (form) {
      body = new URLSearchParams(form).toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    try {
      return await this.request(`${this.base}/api/v2/${path}`, {
        method,
        headers,
        body,
        insecure: this.insecure,
      });
    } catch (err) {
      throw networkError(err);
    }
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
    const response = await this.send('auth/login', {
      method: 'POST',
      form: { username: this.username, password: this.password },
    });
    let error = null;
    if (response.status === 403) {
      error = new ClientError(ERROR_KINDS.BANNED, 'Address banned after failed logins', {
        status: 403,
      });
    } else if (response.status === 401 || response.body.trim() === 'Fails.') {
      error = new ClientError(ERROR_KINDS.AUTH, 'User name or password refused');
    } else if (response.status !== 200 && response.status !== 204) {
      error = statusError(response, 'Login');
    }
    if (error) {
      this.guard.failed(error);
      throw error;
    }
    storeCookies(this.cookies, response.headers);
    this.guard.succeeded();
    this.loggedIn = true;
  }

  /** A request that logs in once on a 403 (no session, or an expired one). */
  async call(path, options = {}) {
    if (!this.loggedIn && (this.username || this.password)) {
      await this.login(options);
    }
    let response = await this.send(path, options);
    if (response.status === 403) {
      this.loggedIn = false;
      this.cookies.clear();
      await this.login(options);
      response = await this.send(path, options);
      if (response.status === 403) {
        throw new ClientError(ERROR_KINDS.AUTH, `${path}: HTTP 403 after login`, { status: 403 });
      }
    }
    if (response.status < 200 || response.status >= 300) {
      throw statusError(response, path);
    }
    return response;
  }

  async identify(options) {
    if (this.webApi === null) {
      const [webApi, version] = await Promise.all([
        this.call('app/webapiVersion', options),
        this.call('app/version', options),
      ]);
      this.webApi = versionParts(webApi.body.trim());
      this.version = version.body.trim().replace(/^v/, '') || null;
    }
  }

  /** qBittorrent 5.0 (Web API 2.11.0) and later: stop/start instead of pause/resume. */
  get usesStop() {
    const [major = 0, minor = 0] = this.webApi ?? [];
    return major > 2 || (major === 2 && minor >= 11);
  }

  /** @returns {Promise<object>} a reading, in the shape of src/model.js */
  async read({ force = false } = {}) {
    await this.identify({ force });
    const response = await this.call(`sync/maindata?rid=${this.rid}`, { force });
    const data = parseJson(response.body);
    if (!data || typeof data !== 'object' || typeof data.rid !== 'number') {
      throw new ClientError(ERROR_KINDS.NOT_FOUND, 'sync/maindata: not a qBittorrent answer');
    }
    this.merge(data);
    const server = this.server;
    const freeSpace = Number(server.free_space_on_disk);
    return {
      version: this.version,
      downloadSpeed: Number(server.dl_info_speed) || 0,
      uploadSpeed: Number(server.up_info_speed) || 0,
      // -1 until qBittorrent has computed it once.
      freeSpace: Number.isFinite(freeSpace) && freeSpace >= 0 ? freeSpace : null,
      altSpeed:
        typeof server.use_alt_speed_limits === 'boolean' ? server.use_alt_speed_limits : null,
      torrents: [...this.raw.entries()].map(([hash, raw]) => toTorrent(hash, raw)),
    };
  }

  merge(data) {
    if (data.full_update) {
      this.raw = new Map();
      this.server = {};
    }
    for (const [hash, changes] of Object.entries(data.torrents ?? {})) {
      const known = this.raw.get(hash) ?? {};
      for (const field of FIELDS) {
        if (changes && field in changes) {
          known[field] = changes[field];
        }
      }
      this.raw.set(hash, known);
    }
    for (const hash of data.torrents_removed ?? []) {
      this.raw.delete(hash);
    }
    Object.assign(this.server, data.server_state ?? {});
    this.rid = data.rid;
  }

  async pauseAll() {
    await this.identify();
    await this.call(this.usesStop ? 'torrents/stop' : 'torrents/pause', {
      method: 'POST',
      form: { hashes: 'all' },
    });
  }

  async resumeAll() {
    await this.identify();
    await this.call(this.usesStop ? 'torrents/start' : 'torrents/resume', {
      method: 'POST',
      form: { hashes: 'all' },
    });
  }

  /** Alternative speed limits on or off (qBittorrent only offers a toggle). */
  async setAltSpeed(enabled) {
    const mode = await this.call('transfer/speedLimitsMode');
    const current = mode.body.trim() === '1';
    if (current !== enabled) {
      await this.call('transfer/toggleSpeedLimitsMode', { method: 'POST' });
    }
    this.server.use_alt_speed_limits = enabled;
  }

  /** @returns {Promise<{ hash: string }>} */
  async addMagnet(uri) {
    const hash = magnetHash(uri);
    if (!hash) {
      throw new ClientError(ERROR_KINDS.REJECTED, 'Not a magnet link');
    }
    let response;
    try {
      response = await this.call('torrents/add', { method: 'POST', form: { urls: uri } });
    } catch (err) {
      // 409: already there (qBittorrent 5), 415: not a torrent.
      if ([409, 415].includes(err.status)) {
        throw new ClientError(ERROR_KINDS.REJECTED, `torrents/add: HTTP ${err.status}`);
      }
      throw err;
    }
    // "Ok." / "Fails." until Web API 2.13; JSON counts since (qBittorrent 5.1).
    const answer = parseJson(response.body);
    if (
      response.body.trim() === 'Fails.' ||
      (answer && typeof answer === 'object' && answer.success_count === 0)
    ) {
      throw new ClientError(ERROR_KINDS.REJECTED, 'torrents/add: refused');
    }
    return { hash };
  }

  async logout() {
    if (!this.loggedIn) {
      return;
    }
    this.loggedIn = false;
    await this.send('auth/logout', { method: 'POST' }).catch(() => {});
    this.cookies.clear();
  }
}
