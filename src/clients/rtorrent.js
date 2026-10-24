// -----------------------------------------------------------------------------
// rTorrent client, through its XML-RPC interface served over HTTP: rTorrent
// itself only opens an SCGI socket, a web server (nginx, lighttpd, Apache)
// publishes it, usually on `/RPC2`, often behind HTTP Basic authentication.
// ruTorrent and Flood setups have it. The SCGI socket reached directly is not
// supported (no HTTP).
//
// Stateless: every request carries the Basic credentials (no session). A
// refused password (401) goes through the same login back-off as the other
// clients: some seedboxes ban an address after failed logins.
//
// Reading: one system.multicall (version, global rates, default directory,
// and d.multicall2 on the `main` view with only the fields used). rTorrent
// has no global free space: the integration reads d.free_diskspace, the free
// space of the partition of a torrent, from a torrent in the default
// directory (else the first one); none without torrents. rTorrent has no
// alternative speed mode: the switch is not offered on rTorrent devices.
//
// States (as ruTorrent reads them): d.state 0 = stopped, d.state 1 and
// d.is_active 0 = paused; a non-empty d.message is an error, except the
// tracker messages ("Tracker: [...]"), which only say a tracker failed. A
// torrent whose data went missing is stopped by rTorrent with a message:
// counted in error (in progress), not paused.
// -----------------------------------------------------------------------------

import { httpRequest } from './http.js';
import {
  ClientError,
  ERROR_KINDS,
  LoginGuard,
  epochMs,
  magnetHash,
  networkError,
  statusError,
} from './common.js';
import { XmlRpcFault, decodeResponse, encodeCall } from './xmlrpc.js';

// d.multicall2 fields, in this order. d.is_meta and d.load_date are newer
// (rTorrent 0.9.7): an older rTorrent answers "Command ... does not exist",
// and the client reads again without them.
const FIELDS = [
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
];
const NEWER_FIELDS = ['d.is_meta=', 'd.load_date='];

/** The XML-RPC address: `/RPC2` added unless the path already names one. */
export function rpcUrl(url) {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${/\/rpc2$/i.test(path) || /\.php$/i.test(path) ? path : `${path}/RPC2`}`;
}

/** A ruTorrent label (d.custom1, URL-encoded by ruTorrent). */
function label(raw) {
  if (typeof raw !== 'string' || !raw) {
    return null;
  }
  try {
    return decodeURIComponent(raw).trim() || null;
  } catch {
    return raw.trim() || null;
  }
}

const isError = (message) =>
  typeof message === 'string' && message.trim() !== '' && !/^Tracker:/i.test(message.trim());

/**
 * One row of d.multicall2, in the shape of src/model.js.
 * @param {Array} row values in the order of `fields`
 * @param {string[]} fields
 */
export function toTorrent(row, fields = FIELDS) {
  const raw = Object.fromEntries(fields.map((field, i) => [field.slice(2, -1), row[i]]));
  const hash = String(raw.hash ?? '').toLowerCase();
  const size = Number(raw.size_bytes) || 0;
  const name = typeof raw.name === 'string' && raw.name ? raw.name : hash;
  // A magnet link waiting for its metadata: d.is_meta, or its name on an
  // rTorrent without d.is_meta ("<HASH>.meta").
  const meta = 'is_meta' in raw ? Number(raw.is_meta) === 1 : /\.meta$/i.test(name);
  const hasMetadata = !meta && size > 0;
  const progress = hasMetadata
    ? Math.min(1, Math.max(0, (Number(raw.completed_bytes) || 0) / size))
    : 0;
  const started = Number(raw.state) === 1;
  const active = Number(raw.is_active) === 1;
  const error = isError(raw.message);
  const checking = Number(raw.is_hash_checking) === 1;
  const complete = hasMetadata && Number(raw.complete) === 1;
  return {
    hash,
    name,
    progress,
    paused: !error && !checking && (!started || !active),
    checking,
    downloading: started && active && !complete && !checking && !error,
    error,
    hasMetadata,
    complete,
    downloadSpeed: Number(raw['down.rate']) || 0,
    downloaded: Number(raw['down.total']) || 0,
    size: hasMetadata ? size : null,
    category: label(raw.custom1),
    addedAt: epochMs(Number(raw.load_date)),
  };
}

/** The free space reported by a torrent in the default directory, else by the first one. */
export function freeSpaceOf(rows, fields, defaultDirectory) {
  const at = (field) => fields.indexOf(field);
  const base = String(defaultDirectory ?? '').replace(/\/+$/, '');
  const inDefault = base
    ? rows.find((row) => {
        const directory = String(row[at('d.directory=')] ?? '');
        return directory === base || directory.startsWith(`${base}/`);
      })
    : undefined;
  const row = inDefault ?? rows[0];
  const free = row ? Number(row[at('d.free_diskspace=')]) : NaN;
  return Number.isFinite(free) && free >= 0 ? free : null;
}

export class RtorrentClient {
  /**
   * @param {object} options
   * @param {string} options.url base URL (src/config.js parseClientUrl)
   * @param {string} [options.username] HTTP Basic user name, if the web server asks
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
    now = Date.now,
  }) {
    this.url = rpcUrl(url);
    this.authorization =
      username || password
        ? `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
        : null;
    this.insecure = insecure;
    this.request = request;
    this.guard = new LoginGuard(now);
    this.fields = FIELDS;
    this.version = null;
    this.supportsAltSpeed = false;
  }

  /** One XML-RPC call; a fault becomes a REJECTED error (with the fault attached). */
  async call(method, params = [], { force = false } = {}) {
    this.guard.check(force);
    const headers = { 'content-type': 'text/xml', accept: 'text/xml' };
    if (this.authorization) {
      headers.authorization = this.authorization;
    }
    let response;
    try {
      response = await this.request(this.url, {
        method: 'POST',
        headers,
        body: encodeCall(method, params),
        insecure: this.insecure,
      });
    } catch (err) {
      throw networkError(err);
    }
    if (response.status === 401) {
      const error = new ClientError(
        ERROR_KINDS.AUTH,
        this.authorization ? 'User name or password refused' : 'The web server asks for a login',
        { status: 401 },
      );
      this.guard.failed(error);
      throw error;
    }
    if (response.status !== 200) {
      throw statusError(response, method);
    }
    this.guard.succeeded();
    try {
      return decodeResponse(response.body);
    } catch (err) {
      if (err instanceof XmlRpcFault) {
        throw Object.assign(
          new ClientError(ERROR_KINDS.REJECTED, `${method}: ${err.message.slice(0, 160)}`),
          { fault: err },
        );
      }
      throw new ClientError(ERROR_KINDS.NOT_FOUND, `${method}: not an XML-RPC answer`);
    }
  }

  /** system.multicall: the results, a fault of one call thrown as REJECTED. */
  async multicall(calls, options) {
    const results = await this.call(
      'system.multicall',
      [calls.map(([methodName, params]) => ({ methodName, params }))],
      options,
    );
    if (!Array.isArray(results) || results.length !== calls.length) {
      throw new ClientError(ERROR_KINDS.NOT_FOUND, 'system.multicall: unexpected answer');
    }
    return results.map((result, i) => {
      if (!Array.isArray(result)) {
        const message = String(result?.faultString ?? 'fault').slice(0, 160);
        throw Object.assign(new ClientError(ERROR_KINDS.REJECTED, `${calls[i][0]}: ${message}`), {
          fault: new XmlRpcFault(Number(result?.faultCode) || 0, message),
        });
      }
      return result[0];
    });
  }

  async readOnce(options) {
    const [version, down, up, directory, rows] = await this.multicall(
      [
        ['system.client_version', []],
        ['throttle.global_down.rate', ['']],
        ['throttle.global_up.rate', ['']],
        ['directory.default', ['']],
        ['d.multicall2', ['', 'main', ...this.fields]],
      ],
      options,
    );
    if (!Array.isArray(rows)) {
      throw new ClientError(ERROR_KINDS.NOT_FOUND, 'd.multicall2: unexpected answer');
    }
    this.version = typeof version === 'string' && version ? version : null;
    return {
      version: this.version,
      downloadSpeed: Number(down) || 0,
      uploadSpeed: Number(up) || 0,
      freeSpace: freeSpaceOf(rows, this.fields, directory),
      altSpeed: null,
      torrents: rows
        .filter((row) => Array.isArray(row) && row.length === this.fields.length)
        .map((row) => toTorrent(row, this.fields)),
    };
  }

  /** @returns {Promise<object>} a reading, in the shape of src/model.js */
  async read({ force = false } = {}) {
    try {
      return await this.readOnce({ force });
    } catch (err) {
      const message = err.fault?.message ?? '';
      if (
        this.fields === FIELDS &&
        NEWER_FIELDS.some((field) => message.includes(field.slice(0, -1)))
      ) {
        this.fields = FIELDS.filter((field) => !NEWER_FIELDS.includes(field));
        return this.readOnce({ force });
      }
      throw err;
    }
  }

  /** Hash, d.state and d.is_active of every torrent. */
  async states() {
    const rows = await this.call('d.multicall2', [
      '',
      'main',
      'd.hash=',
      'd.state=',
      'd.is_active=',
    ]);
    return (Array.isArray(rows) ? rows : [])
      .filter((row) => Array.isArray(row) && typeof row[0] === 'string' && row[0])
      .map(([hash, state, active]) => ({
        hash,
        started: Number(state) === 1,
        active: Number(active) === 1,
      }));
  }

  async each(method, hashes) {
    if (hashes.length > 0) {
      await this.multicall(hashes.map((hash) => [method, [hash]]));
    }
  }

  // d.stop (ruTorrent "Stop") for every started torrent, paused ones included.
  async pauseAll() {
    const torrents = await this.states();
    await this.each(
      'd.stop',
      torrents.filter((t) => t.started).map((t) => t.hash),
    );
  }

  // d.start for the stopped torrents, d.resume for the paused ones (ruTorrent "Pause").
  async resumeAll() {
    const torrents = await this.states();
    await this.each(
      'd.start',
      torrents.filter((t) => !t.started).map((t) => t.hash),
    );
    await this.each(
      'd.resume',
      torrents.filter((t) => t.started && !t.active).map((t) => t.hash),
    );
  }

  async setAltSpeed() {
    throw new ClientError(ERROR_KINDS.UNSUPPORTED, 'rTorrent has no alternative speed mode');
  }

  /** @returns {Promise<{ hash: string }>} */
  async addMagnet(uri) {
    const hash = magnetHash(uri);
    if (!hash) {
      throw new ClientError(ERROR_KINDS.REJECTED, 'Not a magnet link');
    }
    await this.call('load.start', ['', uri]);
    return { hash };
  }

  // No session to close.
  async logout() {}
}
