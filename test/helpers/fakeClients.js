// -----------------------------------------------------------------------------
// In-memory torrent clients behind a fake network, for the tests: they answer
// like the real qBittorrent 4.6 / 5.x Web API, Transmission RPC, Deluge web
// JSON-RPC and rTorrent XML-RPC, as observed on qbittorrent-nox 4.6.3,
// transmission-daemon 4.0.5, Deluge 2.1 and rTorrent 0.16.25 (the recorded
// answers are in test/fixtures/). Each
// keeps the requests it received, never the passwords.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import {
  decodeCall,
  decodeResponse,
  encodeFault,
  encodeResponse,
} from '../../src/clients/xmlrpc.js';

export const fixture = (path) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${path}`, import.meta.url), 'utf8'));

const json = (status, body, headers = {}) => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const text = (status, body, headers = {}) => ({
  status,
  headers: { 'content-type': 'text/plain', ...headers },
  body,
});

const parseCookies = (header = '') =>
  Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim().split('='))
      .filter(([name]) => name),
  );

// --- qBittorrent ----------------------------------------------------------------

export class FakeQbittorrent {
  /**
   * @param {object} [options]
   * @param {string} [options.username]
   * @param {string} [options.password]
   * @param {string} [options.webApi] "2.9.3" (4.6) or "2.11.4" (5.x: stop/start)
   * @param {object} [options.maindata] the first full answer (fixture by default)
   */
  constructor({
    username = 'admin',
    password = 'secret',
    version = 'v4.6.3',
    webApi = '2.9.3',
    maindata = fixture('qbittorrent/maindata-full.json'),
    banAfter = 5,
  } = {}) {
    this.username = username;
    this.password = password;
    this.version = version;
    this.webApi = webApi;
    this.torrents = structuredClone(maindata.torrents ?? {});
    this.server = structuredClone(maindata.server_state ?? {});
    this.online = true;
    this.requests = [];
    this.sessions = new Set();
    this.failures = 0;
    this.banAfter = banAfter;
    this.snapshots = new Map();
    this.rid = 0;
    this.nextSid = 1;
  }

  get stopped() {
    return /^2\.(1[1-9]|[2-9]\d)/.test(this.webApi);
  }

  /** Set fields of a torrent, as qBittorrent would update them. */
  update(hash, fields) {
    this.torrents[hash] = { ...(this.torrents[hash] ?? {}), ...fields };
  }

  remove(hash) {
    delete this.torrents[hash];
  }

  snapshot() {
    return structuredClone({ torrents: this.torrents, server: this.server });
  }

  maindata(rid) {
    const before = this.snapshots.get(rid);
    this.rid += 1;
    const now = this.snapshot();
    this.snapshots.set(this.rid, now);
    if (!before) {
      return {
        full_update: true,
        rid: this.rid,
        server_state: now.server,
        torrents: now.torrents,
      };
    }
    const torrents = {};
    for (const [hash, fields] of Object.entries(now.torrents)) {
      const old = before.torrents[hash];
      const changed = Object.fromEntries(
        Object.entries(fields).filter(([key, value]) => !old || old[key] !== value),
      );
      if (Object.keys(changed).length > 0) {
        torrents[hash] = changed;
      }
    }
    const removed = Object.keys(before.torrents).filter((hash) => !(hash in now.torrents));
    const server = Object.fromEntries(
      Object.entries(now.server).filter(([key, value]) => before.server[key] !== value),
    );
    return {
      rid: this.rid,
      ...(Object.keys(server).length ? { server_state: server } : {}),
      ...(Object.keys(torrents).length ? { torrents } : {}),
      ...(removed.length ? { torrents_removed: removed } : {}),
    };
  }

  setAll(state) {
    for (const torrent of Object.values(this.torrents)) {
      const done = torrent.progress >= 1;
      torrent.state = `${state}${done ? 'UP' : 'DL'}`;
      torrent.dlspeed = 0;
    }
  }

  handle(url, { method = 'GET', headers = {}, body } = {}) {
    const target = new URL(url);
    const path = target.pathname.replace(/^.*\/api\/v2\//, '');
    const form = Object.fromEntries(new URLSearchParams(body ?? ''));
    this.requests.push({ method, path, query: target.search });
    if (!target.pathname.includes('/api/v2/')) {
      return text(404, 'Not Found');
    }
    if (path === 'auth/login') {
      if (this.failures >= this.banAfter) {
        return text(
          403,
          'Your IP address has been banned after too many failed authentication attempts.',
        );
      }
      if (form.username !== this.username || form.password !== this.password) {
        this.failures += 1;
        return text(200, 'Fails.');
      }
      this.failures = 0;
      const sid = `sid${this.nextSid++}`;
      this.sessions.add(sid);
      return text(200, 'Ok.', { 'set-cookie': [`SID=${sid}; HttpOnly; path=/; SameSite=Strict`] });
    }
    const sid = parseCookies(headers.cookie).SID;
    if (!this.sessions.has(sid)) {
      return text(403, 'Forbidden');
    }
    switch (path) {
      case 'auth/logout':
        this.sessions.delete(sid);
        return text(200, '');
      case 'app/version':
        return text(200, this.version);
      case 'app/webapiVersion':
        return text(200, this.webApi);
      case 'sync/maindata':
        return json(200, this.maindata(Number(target.searchParams.get('rid') ?? 0)));
      case 'transfer/speedLimitsMode':
        return text(200, this.server.use_alt_speed_limits ? '1' : '0');
      case 'transfer/toggleSpeedLimitsMode':
        this.server.use_alt_speed_limits = !this.server.use_alt_speed_limits;
        return text(200, '');
      case 'torrents/pause':
      case 'torrents/resume':
      case 'torrents/stop':
      case 'torrents/start': {
        const verb = path.split('/')[1];
        if (['stop', 'start'].includes(verb) !== this.stopped) {
          return text(404, 'Not Found');
        }
        this.setAll(
          ['pause', 'stop'].includes(verb) ? (this.stopped ? 'stopped' : 'paused') : 'stalled',
        );
        return text(200, '');
      }
      case 'torrents/add': {
        const match = String(form.urls ?? '').match(/btih:([a-z0-9]+)/i);
        if (!match) {
          return text(200, 'Fails.');
        }
        const hash = match[1].toLowerCase();
        if (this.torrents[hash]) {
          return this.stopped ? text(409, 'Conflict') : text(200, 'Fails.');
        }
        this.update(hash, {
          name: hash,
          progress: 0,
          state: 'metaDL',
          dlspeed: 0,
          downloaded: 0,
          size: 0,
          total_size: -1,
          category: '',
          added_on: 1792005587,
        });
        return text(200, 'Ok.');
      }
      default:
        return text(404, 'Not Found');
    }
  }
}

// --- Transmission ---------------------------------------------------------------

export class FakeTransmission {
  constructor({
    username = 'gladys',
    password = 'secret',
    torrents = fixture('transmission/torrent-get.json').arguments.torrents,
    session = fixture('transmission/session-get.json').arguments,
    stats = fixture('transmission/session-stats.json').arguments,
    freeSpace = fixture('transmission/free-space.json').arguments['size-bytes'],
    whitelisted = true,
  } = {}) {
    this.username = username;
    this.password = password;
    this.torrents = structuredClone(torrents);
    this.session = structuredClone(session);
    this.stats = structuredClone(stats);
    this.freeSpace = freeSpace;
    this.whitelisted = whitelisted;
    this.online = true;
    this.requests = [];
    this.sessionId = 'session-1';
  }

  /** Change the CSRF id, as a daemon restart does. */
  restart() {
    this.sessionId = `session-${Number(this.sessionId.split('-')[1]) + 1}`;
  }

  update(hash, fields) {
    const torrent = this.torrents.find((t) => t.hashString === hash);
    if (torrent) {
      Object.assign(torrent, fields);
    } else {
      this.torrents.push({ hashString: hash, ...fields });
    }
  }

  handle(url, { headers = {}, body } = {}) {
    if (new URL(url).pathname !== '/transmission/rpc') {
      this.requests.push({ path: new URL(url).pathname });
      return text(404, 'Not Found');
    }
    const payload = JSON.parse(body ?? '{}');
    this.requests.push({ path: new URL(url).pathname, method: payload.method });
    if (!this.whitelisted) {
      return text(403, '<h1>403: Forbidden</h1><p>Unauthorized IP Address.</p>');
    }
    if (this.username || this.password) {
      const expected = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`;
      if (headers.authorization !== expected) {
        return text(401, '<h1>401: Unauthorized</h1>');
      }
    }
    if (headers['x-transmission-session-id'] !== this.sessionId) {
      return text(409, '<h1>409: Conflict</h1>', { 'x-transmission-session-id': this.sessionId });
    }
    const args = payload.arguments ?? {};
    const ok = (result) => json(200, { arguments: result, result: 'success' });
    switch (payload.method) {
      case 'session-get':
        return ok(this.session);
      case 'session-stats':
        return ok(this.stats);
      case 'torrent-get':
        return ok({
          torrents: this.torrents.map((torrent) =>
            Object.fromEntries(
              Object.entries(torrent).filter(([key]) => args.fields.includes(key)),
            ),
          ),
        });
      case 'free-space':
        return ok({
          path: args.path,
          'size-bytes': this.freeSpace,
          total_size: this.freeSpace * 4,
        });
      case 'session-set':
        Object.assign(this.session, args);
        return ok({});
      case 'torrent-stop':
        for (const torrent of this.torrents) {
          torrent.status = 0;
          torrent.rateDownload = 0;
        }
        return ok({});
      case 'torrent-start':
        for (const torrent of this.torrents) {
          torrent.status = torrent.percentDone >= 1 ? 6 : 4;
        }
        return ok({});
      case 'torrent-add': {
        const hash = String(args.filename)
          .match(/btih:([a-z0-9]+)/i)?.[1]
          ?.toLowerCase();
        if (!hash) {
          return json(200, { arguments: {}, result: 'invalid or corrupt torrent file' });
        }
        const existing = this.torrents.find((t) => t.hashString === hash);
        if (existing) {
          return ok({ 'torrent-duplicate': { hashString: hash, id: 9, name: existing.name } });
        }
        this.update(hash, {
          name: hash,
          status: 4,
          percentDone: 0,
          metadataPercentComplete: 0,
          rateDownload: 0,
          downloadedEver: 0,
          sizeWhenDone: 0,
          error: 0,
          addedDate: 1792005700,
          labels: [],
        });
        return ok({ 'torrent-added': { hashString: hash, id: 9, name: hash } });
      }
      default:
        return json(200, { arguments: {}, result: 'method name not recognized' });
    }
  }
}

// --- Deluge ---------------------------------------------------------------------

export class FakeDeluge {
  constructor({
    password = 'deluge',
    update = fixture('deluge/update-ui.json').result,
    daemonConnected = true,
    hosts = [['45262d454d8c404ba390de6b430534c1', '127.0.0.1', 58846, 'localclient']],
  } = {}) {
    this.password = password;
    this.torrents = structuredClone(update.torrents);
    this.stats = structuredClone(update.stats);
    this.daemonConnected = daemonConnected;
    this.daemonOnline = true;
    this.hosts = hosts;
    this.online = true;
    this.requests = [];
    this.sessions = new Set();
    this.nextSid = 1;
  }

  update(hash, fields) {
    this.torrents[hash] = { ...(this.torrents[hash] ?? {}), ...fields };
  }

  handle(url, { headers = {}, body } = {}) {
    if (new URL(url).pathname !== '/json') {
      return text(404, 'Not Found');
    }
    const { method, params = [], id } = JSON.parse(body ?? '{}');
    this.requests.push({ method });
    const answer = (result, extra) => json(200, { result, error: null, id }, extra);
    const failure = (code, message) => json(200, { result: null, error: { message, code }, id });
    if (method === 'auth.login') {
      if (params[0] !== this.password) {
        return answer(false);
      }
      const sid = `deluge-sid-${this.nextSid++}`;
      this.sessions.add(sid);
      return answer(true, { 'set-cookie': `_session_id=${sid}; Path=/json` });
    }
    const sid = parseCookies(headers.cookie)._session_id;
    if (!this.sessions.has(sid)) {
      return failure(1, 'Not authenticated');
    }
    switch (method) {
      case 'auth.delete_session':
        this.sessions.delete(sid);
        return answer(true);
      case 'web.connected':
        return answer(this.daemonConnected);
      case 'web.get_hosts':
        return answer(this.hosts);
      case 'web.connect':
        if (!this.daemonOnline) {
          return failure(4, 'Failure: connection refused');
        }
        this.daemonConnected = true;
        return answer(['core.pause_torrent', 'core.resume_torrent']);
      case 'daemon.get_version':
        return answer('2.1.2.dev0');
      case 'web.update_ui': {
        if (!this.daemonConnected) {
          return answer({ connected: false, torrents: null, filters: null, stats: {} });
        }
        const keys = params[0];
        const torrents = Object.fromEntries(
          Object.entries(this.torrents).map(([hash, torrent]) => [
            hash,
            Object.fromEntries(Object.entries(torrent).filter(([key]) => keys.includes(key))),
          ]),
        );
        return answer({ connected: true, torrents, filters: {}, stats: this.stats });
      }
      case 'core.get_torrents_status':
        return answer(
          Object.fromEntries(
            Object.entries(this.torrents).map(([hash, t]) => [hash, { name: t.name }]),
          ),
        );
      case 'core.pause_torrent':
      case 'core.resume_torrent':
        for (const hash of params[0]) {
          const torrent = this.torrents[hash];
          if (torrent) {
            torrent.state =
              method === 'core.pause_torrent'
                ? 'Paused'
                : torrent.progress >= 100
                  ? 'Seeding'
                  : 'Downloading';
          }
        }
        return answer(null);
      case 'core.add_torrent_magnet': {
        const hash = String(params[0])
          .match(/btih:([a-z0-9]+)/i)?.[1]
          ?.toLowerCase();
        if (this.torrents[hash]) {
          return failure(4, `Failure: AddTorrentError: Torrent already in session (${hash}).`);
        }
        this.update(hash, {
          name: hash,
          state: 'Downloading',
          progress: 0,
          download_payload_rate: 0,
          all_time_download: 0,
          total_wanted: 0,
          time_added: 1792005700,
        });
        return answer(hash);
      }
      default:
        return failure(2, 'Unknown method');
    }
  }
}

// --- rTorrent -------------------------------------------------------------------

// The rows of a recorded system.multicall answer (test/fixtures/rtorrent/),
// as torrents keyed by d.multicall2 field ("d.name=" → value).
const READ_FIELDS = [
  'd.hash=',
  'd.name=',
  'd.complete=',
  'd.is_active=',
  'd.state=',
  'd.message=',
  'd.down.rate=',
  'd.completed_bytes=',
  'd.size_bytes=',
  'd.down.total=',
  'd.is_hash_checking=',
  'd.custom1=',
  'd.free_diskspace=',
  'd.directory=',
  'd.is_meta=',
  'd.load_date=',
  'd.wanted_chunks=',
];

export const rtorrentFixture = (name = 'read-0.16.25.xml') =>
  decodeResponse(readFileSync(new URL(`../fixtures/rtorrent/${name}`, import.meta.url), 'utf8'));

export class FakeRtorrent {
  /**
   * @param {object} [options]
   * @param {string} [options.username] HTTP Basic, none when both are empty
   * @param {string} [options.password]
   * @param {boolean} [options.legacy] an rTorrent before 0.9.7 (no d.is_meta, d.load_date)
   * @param {string} [options.recorded] the fixture file
   */
  constructor({ username = '', password = '', legacy = false, recorded } = {}) {
    const [[version], [down], [up], [directory], [rows]] = rtorrentFixture(recorded);
    this.username = username;
    this.password = password;
    this.legacy = legacy;
    this.version = version;
    this.down = down;
    this.up = up;
    this.directory = directory;
    this.torrents = new Map(
      rows.map((row) => {
        const torrent = Object.fromEntries(READ_FIELDS.map((f, i) => [f, row[i]]));
        // Not in the recorded answers: what rTorrent 0.16.25 gave for them.
        torrent['d.wanted_chunks='] ??= torrent['d.complete='] === 1 ? 0 : 12;
        return [row[0], torrent];
      }),
    );
    this.online = true;
    this.requests = [];
  }

  update(hash, fields) {
    this.torrents.set(hash, { ...(this.torrents.get(hash) ?? {}), ...fields });
  }

  known(command) {
    return !(this.legacy && ['d.is_meta=', 'd.load_date='].includes(command));
  }

  dispatch(method, params) {
    this.requests.push({ method });
    const torrent = () => this.torrents.get(params[0]);
    switch (method) {
      case 'system.multicall':
        return params[0].map(({ methodName, params: inner }) => {
          try {
            return [this.dispatch(methodName, inner)];
          } catch (fault) {
            return { faultCode: fault.code, faultString: fault.message };
          }
        });
      case 'system.client_version':
        return this.version;
      case 'throttle.global_down.rate':
        return this.down;
      case 'throttle.global_up.rate':
        return this.up;
      case 'directory.default':
        return this.directory;
      case 'd.multicall2': {
        const fields = params.slice(2);
        const unknown = fields.find((f) => !READ_FIELDS.includes(f) || !this.known(f));
        if (unknown) {
          throw Object.assign(new Error(`Command "${unknown.slice(0, -1)}" does not exist.`), {
            code: -500,
          });
        }
        return [...this.torrents.values()].map((t) => fields.map((f) => t[f]));
      }
      case 'd.stop':
      case 'd.start':
      case 'd.pause':
      case 'd.resume': {
        const t = torrent();
        if (!t) {
          throw Object.assign(new Error('Could not find info-hash.'), { code: -501 });
        }
        if (method === 'd.stop') {
          Object.assign(t, { 'd.state=': 0, 'd.is_active=': 0 });
        } else if (method === 'd.start') {
          Object.assign(t, { 'd.state=': 1, 'd.is_active=': 1 });
        } else if (method === 'd.pause') {
          t['d.is_active='] = 0;
        } else if (t['d.state='] === 1) {
          t['d.is_active='] = 1;
        }
        return 0;
      }
      case 'load.start': {
        const hash = String(params[1])
          .match(/btih:([a-z0-9]+)/i)?.[1]
          ?.toUpperCase();
        if (hash && !this.torrents.has(hash)) {
          this.update(hash, {
            ...Object.fromEntries(READ_FIELDS.map((f) => [f, 0])),
            'd.hash=': hash,
            'd.name=': `${hash}.meta`,
            'd.state=': 1,
            'd.is_active=': 1,
            'd.message=': 'Tracker: [No DHT nodes available for peer search.]',
            'd.size_bytes=': 1,
            'd.custom1=': '',
            'd.directory=': '/data/rtorrent/.session',
            'd.is_meta=': 1,
            'd.wanted_chunks=': 1,
          });
        }
        return 0;
      }
      default:
        throw Object.assign(new Error(`method '${method}' not defined`), { code: -506 });
    }
  }

  handle(url, { headers = {}, body } = {}) {
    if (new URL(url).pathname !== '/RPC2') {
      return text(404, '<html><body>404 Not Found</body></html>');
    }
    if (this.username || this.password) {
      const expected = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`;
      if (headers.authorization !== expected) {
        return text(401, '<html><body>401 Authorization Required</body></html>', {
          'www-authenticate': 'Basic realm="rTorrent XMLRPC restricted access"',
        });
      }
    }
    const { method, params } = decodeCall(body);
    let answer;
    try {
      answer = encodeResponse(this.dispatch(method, params));
    } catch (fault) {
      answer = encodeFault(fault.code ?? -500, fault.message);
    }
    return { status: 200, headers: { 'content-type': 'text/xml' }, body: answer };
  }
}

// --- Network ----------------------------------------------------------------------

/**
 * The fake network: routes a request to the server of its origin.
 * @param {Record<string, { handle: Function, online: boolean }>} servers by origin
 */
export function createNetwork(servers) {
  const network = {
    servers,
    requests: [],
    async request(url, options = {}) {
      const { origin } = new URL(url);
      network.requests.push({ url, options });
      const server = network.servers[origin];
      if (!server || !server.online) {
        const error = new Error(`connect ECONNREFUSED ${new URL(url).host}`);
        error.code = 'ECONNREFUSED';
        throw error;
      }
      return server.handle(url, options);
    },
  };
  return network;
}
