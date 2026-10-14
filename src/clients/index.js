// -----------------------------------------------------------------------------
// One client class per software, same interface: read(), pauseAll(),
// resumeAll(), setAltSpeed(enabled), addMagnet(uri), logout(), and the
// `supportsAltSpeed` flag. A reading is described in src/model.js.
// -----------------------------------------------------------------------------

import { CLIENT_TYPES } from '../config.js';
import { DelugeClient } from './deluge.js';
import { QbittorrentClient } from './qbittorrent.js';
import { TransmissionClient } from './transmission.js';

const CLASSES = {
  [CLIENT_TYPES.QBITTORRENT]: QbittorrentClient,
  [CLIENT_TYPES.TRANSMISSION]: TransmissionClient,
  [CLIENT_TYPES.DELUGE]: DelugeClient,
};

/**
 * @param {{ type: string, url: string, username: string, password: string }} client
 * @param {object} options { insecure, request, now }
 */
export function createClient(client, { insecure = false, request, now } = {}) {
  const Class = CLASSES[client.type];
  return new Class({
    url: client.url,
    username: client.username,
    password: client.password,
    insecure,
    ...(request ? { request } : {}),
    ...(now ? { now } : {}),
  });
}

export { ClientError, ERROR_KINDS } from './common.js';
