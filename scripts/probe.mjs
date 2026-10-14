#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Read-only probe of real torrent clients, for whoever has one on their
// network: reads each client given in the environment once, with the code of
// the integration, and prints what Gladys would get. Prints counts, never the
// torrent names, the passwords or the session cookies. Changes nothing.
//
//   QBT_URL=http://192.168.1.10:8080 QBT_USERNAME=admin QBT_PASSWORD=… \
//   TRANSMISSION_URL=… TRANSMISSION_USERNAME=… TRANSMISSION_PASSWORD=… \
//   DELUGE_URL=… DELUGE_PASSWORD=… \
//   node scripts/probe.mjs        # add ALLOW_SELF_SIGNED=1 for a self-signed HTTPS
// -----------------------------------------------------------------------------

import { createClient } from '../src/clients/index.js';
import { normalizeConfig } from '../src/config.js';
import { countTorrents } from '../src/model.js';

const config = normalizeConfig({
  client_1_type: 'qbittorrent',
  client_1_url: process.env.QBT_URL ?? '',
  client_1_username: process.env.QBT_USERNAME ?? '',
  client_1_password: process.env.QBT_PASSWORD ?? '',
  client_2_type: 'transmission',
  client_2_url: process.env.TRANSMISSION_URL ?? '',
  client_2_username: process.env.TRANSMISSION_USERNAME ?? '',
  client_2_password: process.env.TRANSMISSION_PASSWORD ?? '',
  client_3_type: 'deluge',
  client_3_url: process.env.DELUGE_URL ?? '',
  client_3_password: process.env.DELUGE_PASSWORD ?? '',
  allow_self_signed: process.env.ALLOW_SELF_SIGNED === '1',
});

if (config.clients.length === 0) {
  console.log('Set QBT_URL, TRANSMISSION_URL or DELUGE_URL (see the header of this file).');
  process.exit(2);
}

let failed = 0;
for (const client of config.clients) {
  const api = createClient(client, { insecure: config.allowSelfSigned });
  const started = Date.now();
  try {
    const reading = await api.read({ force: true });
    const second = await api.read({ force: true }); // incremental for qBittorrent
    const counts = countTorrents(second.torrents);
    const states = {};
    for (const torrent of second.torrents) {
      const key = torrent.complete
        ? 'complete'
        : torrent.paused
          ? 'paused'
          : torrent.checking
            ? 'checking'
            : torrent.downloading
              ? 'downloading'
              : 'other';
      states[key] = (states[key] ?? 0) + 1;
    }
    console.log(
      JSON.stringify({
        type: client.type,
        version: reading.version,
        ms: Date.now() - started,
        torrents: counts,
        states,
        withoutMetadata: second.torrents.filter((t) => !t.hasMetadata).length,
        withCategory: second.torrents.filter((t) => t.category).length,
        downloadSpeed: second.downloadSpeed,
        uploadSpeed: second.uploadSpeed,
        freeSpaceKnown: second.freeSpace !== null,
        altSpeed: second.altSpeed,
      }),
    );
  } catch (err) {
    failed += 1;
    console.log(
      JSON.stringify({ type: client.type, error: err.kind ?? 'crash', message: err.message }),
    );
  } finally {
    await api.logout().catch(() => {});
  }
}
process.exit(failed ? 1 : 0);
