// -----------------------------------------------------------------------------
// One Gladys device per torrent client.
//
// Identity: the software and the configuration slot (1 to 3), e.g.
// `qbittorrent:1`, not the address: moving a client to another port or to
// HTTPS keeps the device and its history. None of the three programs exposes
// a stable instance id to use instead. Choosing another software in a slot
// makes another device: its features are not the same (Deluge has no
// alternative speed mode).
//
// Features (category/type couples of the core table, see
// test/gladys-rules.test.js):
//   - download and upload speeds: datarate/rate, in kB/s, rounded;
//   - torrents in progress, paused, completed: counter-sensor/integer (the
//     three add up to the total, see src/model.js);
//   - current downloads: text/text, the first three with their percentage;
//   - free space of the download folder: data/size, in GB;
//   - alternative speed limits (qBittorrent "alternative rate limits",
//     Transmission "turtle mode"): switch/binary, writable, absent on Deluge;
//   - connected: input/binary, 1 while the client answers.
//
// The devices are published with should_poll: false: the integration reads
// the clients on its own timer (src/hub.js), at the interval chosen in the
// configuration (GladysAssistant/Gladys#3198: a device created without
// should_poll is never polled, and the interval can be 2 minutes).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { SLOTS, TYPE_NAMES, hostOf } from './config.js';
import { countTorrents, downloadsText, toGigabytes, toKilobytesPerSecond } from './model.js';
import { NO_DOWNLOAD } from './texts.js';

export const URL_PARAM = 'TORRENT_CLIENT_URL';
export const VERSION_PARAM = 'TORRENT_CLIENT_SOFTWARE';

// Suffixes of the feature external ids: permanent once published.
export const FEATURE_KEYS = Object.freeze({
  DOWNLOAD_SPEED: 'download_speed',
  UPLOAD_SPEED: 'upload_speed',
  DOWNLOADING: 'torrents_downloading',
  PAUSED: 'torrents_paused',
  COMPLETED: 'torrents_completed',
  DOWNLOADS: 'current_downloads',
  FREE_SPACE: 'free_space',
  ALT_SPEED: 'alt_speed',
  CONNECTED: 'connected',
});

// Feature names, in the language chosen in the configuration (Gladys does not
// tell a device integration the user's language). Frozen at creation in Gladys.
export const NAMES = {
  en: {
    [FEATURE_KEYS.DOWNLOAD_SPEED]: 'Download speed',
    [FEATURE_KEYS.UPLOAD_SPEED]: 'Upload speed',
    [FEATURE_KEYS.DOWNLOADING]: 'Torrents in progress',
    [FEATURE_KEYS.PAUSED]: 'Paused torrents',
    [FEATURE_KEYS.COMPLETED]: 'Completed torrents',
    [FEATURE_KEYS.DOWNLOADS]: 'Current downloads',
    [FEATURE_KEYS.FREE_SPACE]: 'Free space',
    [FEATURE_KEYS.ALT_SPEED]: 'Alternative speed limits',
    [FEATURE_KEYS.CONNECTED]: 'Client connected',
  },
  fr: {
    [FEATURE_KEYS.DOWNLOAD_SPEED]: 'Débit descendant',
    [FEATURE_KEYS.UPLOAD_SPEED]: 'Débit montant',
    [FEATURE_KEYS.DOWNLOADING]: 'Torrents en cours',
    [FEATURE_KEYS.PAUSED]: 'Torrents en pause',
    [FEATURE_KEYS.COMPLETED]: 'Torrents terminés',
    [FEATURE_KEYS.DOWNLOADS]: 'Téléchargements en cours',
    [FEATURE_KEYS.FREE_SPACE]: 'Espace libre',
    [FEATURE_KEYS.ALT_SPEED]: 'Limites de vitesse alternatives',
    [FEATURE_KEYS.CONNECTED]: 'Client connecté',
  },
  de: {
    [FEATURE_KEYS.DOWNLOAD_SPEED]: 'Download-Geschwindigkeit',
    [FEATURE_KEYS.UPLOAD_SPEED]: 'Upload-Geschwindigkeit',
    [FEATURE_KEYS.DOWNLOADING]: 'Laufende Torrents',
    [FEATURE_KEYS.PAUSED]: 'Pausierte Torrents',
    [FEATURE_KEYS.COMPLETED]: 'Fertige Torrents',
    [FEATURE_KEYS.DOWNLOADS]: 'Aktuelle Downloads',
    [FEATURE_KEYS.FREE_SPACE]: 'Freier Speicherplatz',
    [FEATURE_KEYS.ALT_SPEED]: 'Alternative Geschwindigkeitslimits',
    [FEATURE_KEYS.CONNECTED]: 'Client verbunden',
  },
  es: {
    [FEATURE_KEYS.DOWNLOAD_SPEED]: 'Velocidad de descarga',
    [FEATURE_KEYS.UPLOAD_SPEED]: 'Velocidad de subida',
    [FEATURE_KEYS.DOWNLOADING]: 'Torrents en curso',
    [FEATURE_KEYS.PAUSED]: 'Torrents en pausa',
    [FEATURE_KEYS.COMPLETED]: 'Torrents completados',
    [FEATURE_KEYS.DOWNLOADS]: 'Descargas en curso',
    [FEATURE_KEYS.FREE_SPACE]: 'Espacio libre',
    [FEATURE_KEYS.ALT_SPEED]: 'Límites de velocidad alternativos',
    [FEATURE_KEYS.CONNECTED]: 'Cliente conectado',
  },
};

// Display bounds (the core never applies them on write).
const MAX_SPEED_KBPS = 10_000_000; // 10 GB/s
const MAX_TORRENTS = 1_000_000;
const MAX_FREE_SPACE_GB = 1_000_000; // 1 PB

const sensor = (category, type, max, extra = {}) => ({
  category,
  type,
  read_only: true,
  has_feedback: false,
  keep_history: true,
  min: 0,
  max,
  ...extra,
});

const speed = (value) => ({
  definition: sensor(
    DEVICE_FEATURE_CATEGORIES.DATARATE,
    DEVICE_FEATURE_TYPES.DATARATE.RATE,
    MAX_SPEED_KBPS,
    { unit: DEVICE_FEATURE_UNITS.KILOBYTES_PER_SECOND },
  ),
  value,
});

const counter = (value) => ({
  definition: sensor(
    DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
    DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
    MAX_TORRENTS,
  ),
  value,
});

// Order = display order in Gladys. `value(reading, language)` returns a
// number, `{ text }` for the text feature, or null (nothing to publish).
const FEATURES = {
  [FEATURE_KEYS.DOWNLOAD_SPEED]: speed((r) => (r ? toKilobytesPerSecond(r.downloadSpeed) : null)),
  [FEATURE_KEYS.UPLOAD_SPEED]: speed((r) => (r ? toKilobytesPerSecond(r.uploadSpeed) : null)),
  [FEATURE_KEYS.DOWNLOADING]: counter((r) => (r ? countTorrents(r.torrents).downloading : null)),
  [FEATURE_KEYS.PAUSED]: counter((r) => (r ? countTorrents(r.torrents).paused : null)),
  [FEATURE_KEYS.COMPLETED]: counter((r) => (r ? countTorrents(r.torrents).completed : null)),
  [FEATURE_KEYS.DOWNLOADS]: {
    definition: {
      category: DEVICE_FEATURE_CATEGORIES.TEXT,
      type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
      read_only: true,
      has_feedback: false,
      keep_history: false,
      // NOT NULL in the core, even for a text: 0/0 like Zigbee2MQTT.
      min: 0,
      max: 0,
    },
    value: (r, language) =>
      r
        ? { text: downloadsText(r.torrents, language, NO_DOWNLOAD[language] ?? NO_DOWNLOAD.en) }
        : null,
  },
  [FEATURE_KEYS.FREE_SPACE]: {
    definition: sensor(
      DEVICE_FEATURE_CATEGORIES.DATA,
      DEVICE_FEATURE_TYPES.DATA.SIZE,
      MAX_FREE_SPACE_GB,
      { unit: DEVICE_FEATURE_UNITS.GIGABYTE },
    ),
    value: (r) => (r && r.freeSpace !== null ? toGigabytes(r.freeSpace) : null),
  },
  [FEATURE_KEYS.ALT_SPEED]: {
    definition: {
      category: DEVICE_FEATURE_CATEGORIES.SWITCH,
      type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
      read_only: false,
      has_feedback: true,
      keep_history: true,
      min: 0,
      max: 1,
    },
    value: (r) => (r && typeof r.altSpeed === 'boolean' ? Number(r.altSpeed) : null),
  },
  [FEATURE_KEYS.CONNECTED]: {
    definition: sensor(DEVICE_FEATURE_CATEGORIES.INPUT, DEVICE_FEATURE_TYPES.SENSOR.BINARY, 1),
    // Published from the connection state, not from a reading.
    value: () => null,
  },
};

/** The feature keys of a client: no alternative speed switch on Deluge. */
export const featureKeys = (supportsAltSpeed) =>
  Object.keys(FEATURES).filter((key) => key !== FEATURE_KEYS.ALT_SPEED || supportsAltSpeed);

/** External ids of a client's device and features. */
export const deviceIds = (gladys, client) => gladys.externalIds(client.type, String(client.slot));

/** The configured client of a device external id, null when it is not one of ours. */
export function clientOf(gladys, clients, externalId) {
  return clients.find((client) => deviceIds(gladys, client).device === externalId) ?? null;
}

/** Every external id the integration could ever give a device (slots × software). */
export const allDeviceIds = (gladys, types) =>
  SLOTS.flatMap((slot) => types.map((type) => deviceIds(gladys, { type, slot }).device));

/** The name shown for a client: the one typed in the configuration, else software and address. */
export const clientName = (client) =>
  client.name ?? `${TYPE_NAMES[client.type]} ${hostOf(client.url)}`;

/**
 * The discovery payload of a client.
 * @param {object} gladys SDK client
 * @param {{ slot: number, type: string, url: string, name: string|null }} client
 * @param {boolean} supportsAltSpeed
 * @param {string} language feature names language
 */
export function buildDevice(gladys, client, supportsAltSpeed, language = 'en') {
  const ids = deviceIds(gladys, client);
  const names = NAMES[language] ?? NAMES.en;
  return {
    name: clientName(client),
    external_id: ids.device,
    should_poll: false,
    params: [
      { name: VERSION_PARAM, value: TYPE_NAMES[client.type] },
      { name: URL_PARAM, value: client.url },
    ],
    features: featureKeys(supportsAltSpeed).map((key) => ({
      ...FEATURES[key].definition,
      name: names[key],
      external_id: ids.feature(key),
    })),
  };
}

/**
 * The states of a client, in the publishStates format.
 * @param {object} gladys
 * @param {object} client configured client
 * @param {object|null} reading the last reading (src/model.js), null before the first
 * @param {boolean} connected
 * @param {boolean} supportsAltSpeed
 * @param {string} language
 */
export function deviceStates(gladys, client, { reading, connected, supportsAltSpeed, language }) {
  const ids = deviceIds(gladys, client);
  const states = [];
  for (const key of featureKeys(supportsAltSpeed)) {
    const value =
      key === FEATURE_KEYS.CONNECTED
        ? connected === null
          ? null
          : Number(connected)
        : FEATURES[key].value(reading, language);
    if (value === null || value === undefined) {
      continue;
    }
    states.push(
      typeof value === 'object'
        ? { device_feature_external_id: ids.feature(key), text: value.text }
        : { device_feature_external_id: ids.feature(key), state: value },
    );
  }
  return states;
}
