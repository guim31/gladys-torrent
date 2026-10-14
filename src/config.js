// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
//
// Up to three torrent clients, each in its own slot: software (qBittorrent,
// Transmission or Deluge), address, user name, password, name. The device
// identity is the slot and the software (src/devices.js): changing the
// address of a slot keeps the device and its history.
// -----------------------------------------------------------------------------

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

export const SLOTS = [1, 2, 3];

export const CLIENT_TYPES = Object.freeze({
  QBITTORRENT: 'qbittorrent',
  TRANSMISSION: 'transmission',
  DELUGE: 'deluge',
});

// The port each software listens on out of the box, added when the address
// typed has neither scheme nor port (`192.168.1.10`).
export const DEFAULT_PORTS = {
  [CLIENT_TYPES.QBITTORRENT]: 8080,
  [CLIENT_TYPES.TRANSMISSION]: 9091,
  [CLIENT_TYPES.DELUGE]: 8112,
};

// Display names of the software (brands: never translated).
export const TYPE_NAMES = {
  [CLIENT_TYPES.QBITTORRENT]: 'qBittorrent',
  [CLIENT_TYPES.TRANSMISSION]: 'Transmission',
  [CLIENT_TYPES.DELUGE]: 'Deluge',
};

// Refresh intervals offered in the configuration, in seconds.
export const POLL_INTERVALS = ['10', '15', '30', '60', '120'];

export const DEFAULT_CONFIG = {
  client_1_type: CLIENT_TYPES.QBITTORRENT,
  client_1_url: '',
  client_1_username: '',
  client_1_password: '',
  client_1_name: '',
  client_2_type: CLIENT_TYPES.TRANSMISSION,
  client_2_url: '',
  client_2_username: '',
  client_2_password: '',
  client_2_name: '',
  client_3_type: CLIENT_TYPES.DELUGE,
  client_3_url: '',
  client_3_username: '',
  client_3_password: '',
  client_3_name: '',
  allow_self_signed: false,
  poll_interval: '30',
  allow_magnet: false,
  language: 'fr',
};

const MAX_NAME_LENGTH = 40;

/**
 * Parse the address typed by the user into a base URL: a bare host or IP
 * (`192.0.2.10`, `nas.local:8080`), or the URL copied from the browser
 * (`https://192.0.2.10/transmission/web/`). HTTP by default; the default port
 * of the software when neither a scheme nor a port was typed. The path is
 * kept (a reverse proxy may serve the client under `/qbittorrent`): each
 * client strips the part it adds itself.
 * @param {unknown} raw
 * @param {string} type one of CLIENT_TYPES
 * @returns {string|null} `http(s)://host[:port][/path]`, null when unusable
 */
export function parseClientUrl(raw, type) {
  if (typeof raw !== 'string') {
    return null;
  }
  const text = raw.trim();
  if (!text) {
    return null;
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  let url;
  try {
    url = new URL(hasScheme ? text : `http://${text}`);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    return null;
  }
  // Credentials in the address would end up in the logs and the device params.
  if (url.username || url.password) {
    return null;
  }
  if (!hasScheme && !url.port && DEFAULT_PORTS[type]) {
    url.port = String(DEFAULT_PORTS[type]);
  }
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/** Host part shown to the user (no scheme, no path). */
export const hostOf = (url) => new URL(url).host;

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const text = (key) => (typeof source[key] === 'string' ? source[key].trim() : '');
  const pick = (key, list) => {
    const value = source[key] === undefined || source[key] === null ? '' : String(source[key]);
    return list.includes(value) ? value : DEFAULT_CONFIG[key];
  };
  const flag = (key) => source[key] === true || source[key] === 'true';

  const clients = [];
  const invalidSlots = [];
  for (const slot of SLOTS) {
    const typed = text(`client_${slot}_url`);
    if (!typed) {
      continue;
    }
    const type = pick(`client_${slot}_type`, Object.values(CLIENT_TYPES));
    const url = parseClientUrl(typed, type);
    if (!url) {
      invalidSlots.push(slot);
      continue;
    }
    clients.push({
      slot,
      type,
      url,
      username: text(`client_${slot}_username`),
      // Passwords are kept as typed: spaces may be part of them.
      password:
        typeof source[`client_${slot}_password`] === 'string'
          ? source[`client_${slot}_password`]
          : '',
      name: text(`client_${slot}_name`).slice(0, MAX_NAME_LENGTH) || null,
    });
  }

  return {
    clients,
    invalidSlots,
    allowSelfSigned: flag('allow_self_signed'),
    pollIntervalMs: Number(pick('poll_interval', POLL_INTERVALS)) * 1000,
    allowMagnet: flag('allow_magnet'),
    language: pick('language', LANGUAGES),
  };
}
