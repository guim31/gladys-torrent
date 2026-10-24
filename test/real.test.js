// -----------------------------------------------------------------------------
// Optional test against the real software (`npm run test:real`), skipped
// unless the addresses are given in the environment — so skipped in CI:
//
//   QBT_URL=http://127.0.0.1:8080 QBT_USERNAME=admin QBT_PASSWORD=…
//   TRANSMISSION_URL=http://127.0.0.1:9091 TRANSMISSION_USERNAME=… TRANSMISSION_PASSWORD=…
//   DELUGE_URL=http://127.0.0.1:8112 DELUGE_PASSWORD=deluge
//   RTORRENT_URL=http://127.0.0.1:8000/RPC2 RTORRENT_USERNAME=… RTORRENT_PASSWORD=…
//
// Use a test instance: the test pauses and resumes every torrent, and turns
// the alternative speed limits on then back to how they were. It never
// deletes anything. How to run the four programs locally: CLAUDE.md.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { registerHandlers } from '../src/app.js';

process.env.LOG_LEVEL ??= 'silent';

const table = JSON.parse(
  await readFile(new URL('./fixtures/gladys-feature-table.json', import.meta.url), 'utf8'),
);

const CLIENTS = [
  {
    type: 'qbittorrent',
    url: process.env.QBT_URL,
    username: process.env.QBT_USERNAME,
    password: process.env.QBT_PASSWORD,
  },
  {
    type: 'transmission',
    url: process.env.TRANSMISSION_URL,
    username: process.env.TRANSMISSION_USERNAME,
    password: process.env.TRANSMISSION_PASSWORD,
  },
  { type: 'deluge', url: process.env.DELUGE_URL, password: process.env.DELUGE_PASSWORD },
  {
    type: 'rtorrent',
    url: process.env.RTORRENT_URL,
    username: process.env.RTORRENT_USERNAME,
    password: process.env.RTORRENT_PASSWORD,
  },
];

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const client of CLIENTS) {
  test(`real ${client.type}`, { skip: !client.url && `no ${client.type} address` }, async () => {
    const gladys = createFakeGladys({
      config: {
        client_1_type: client.type,
        client_1_url: client.url,
        client_1_username: client.username ?? '',
        client_1_password: client.password ?? '',
        allow_self_signed: true,
        language: 'en',
      },
    });
    const app = registerHandlers(gladys, { timers: false });
    try {
      await gladys.connect();
      await app.ready;
      assert.deepEqual(gladys.fake.connectionStatus, { connected: true });

      // The device follows the core rules, and every feature has a state.
      const [device] = gladys.fake.discoveredDevices;
      for (const feature of device.features) {
        assert.ok(table.pairs[`${feature.category}/${feature.type}`], feature.name);
        assert.equal(typeof feature.min, 'number');
        const last = gladys.fake.states.findLast(
          (s) => s.device_feature_external_id === feature.external_id,
        );
        if (feature.external_id.endsWith(':free_space') && !last) {
          continue; // qBittorrent computes it lazily, after a first reading
        }
        assert.ok(last, `${feature.name}: no state`);
      }

      const record = app.hub.records.get(1);
      const report = await gladys.fake.action('test_connection', {});
      assert.match(report.data.message.en, /: OK, /);

      // Pause everything, resume everything.
      const total = record.reading.torrents.length;
      assert.equal((await gladys.fake.sceneAction('pause_all', {})).success, true);
      await settle(1500);
      await app.hub.pollAll();
      // rTorrent stops a torrent whose data went missing, with an error: it cannot be paused.
      const paused = record.reading.torrents.filter(
        (t) => t.paused || t.complete || (client.type === 'rtorrent' && t.error),
      );
      assert.equal(paused.length, total, 'every torrent paused (or complete)');
      assert.equal((await gladys.fake.sceneAction('resume_all', {})).success, true);
      await settle(1500);
      await app.hub.pollAll();
      assert.equal(record.reading.torrents.filter((t) => t.paused).length, 0, 'resumed');

      // The alternative speed limits, then back to how they were.
      if (record.api.supportsAltSpeed) {
        const before = record.reading.altSpeed;
        await gladys.fake.sceneAction('set_alt_speed', { state: before ? 'off' : 'on' });
        await app.hub.pollAll();
        assert.equal(record.reading.altSpeed, !before);
        await gladys.fake.sceneAction('set_alt_speed', { state: before ? 'on' : 'off' });
        await app.hub.pollAll();
        assert.equal(record.reading.altSpeed, before);
      } else {
        const ack = await gladys.fake.sceneAction('set_alt_speed', { state: 'on' });
        assert.equal(ack.success, false);
      }

      const widget = await gladys.fake.widgetGet('torrents', { settings: {}, language: 'fr' });
      assert.deepEqual(validateWidgetContent(widget.data.content), []);
    } finally {
      await app.stop();
    }
  });
}
