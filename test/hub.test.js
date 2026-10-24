// -----------------------------------------------------------------------------
// The whole integration on the SDK's fake Gladys and the fake clients:
// discovery, states, scene events, commands, connection status.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_EVENTS_PER_READING, TRIGGERS } from '../src/hub.js';
import {
  QB_CONFIG,
  QB_URL,
  RT_URL,
  THREE_CLIENTS,
  WITH_RTORRENT,
  createAll,
  createWorld,
  ids,
} from './helpers/world.js';

const MAGNET = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Sintel';
const [UBUNTU, DEBIAN] = [
  '026a771e6576fb1e05e102ef0f1615e2732a0667',
  'f0f72a7a266aba79d6c5e031c93813ce733c6996',
];

async function world(t, options) {
  const w = await createWorld(options);
  t.after(() => w.app.stop());
  return w;
}

test('one device per client, named after the configuration, never polled by Gladys', async (t) => {
  const w = await world(t, { config: THREE_CLIENTS });
  const devices = w.fake.discoveredDevices;
  assert.deepEqual(
    devices.map((d) => [d.external_id, d.name, d.should_poll]),
    [
      [ids(w.gladys).device, 'NAS', false],
      [ids(w.gladys, 'transmission', 2).device, 'Transmission 192.0.2.11:9091', false],
      [ids(w.gladys, 'deluge', 3).device, 'Deluge 198.51.100.12:8112', false],
    ],
  );
  const keys = (device) => device.features.map((f) => f.external_id.split(':').pop());
  assert.ok(keys(devices[0]).includes('alt_speed'));
  assert.ok(!keys(devices[2]).includes('alt_speed'), 'Deluge has no alternative speed');
  assert.deepEqual(devices[0].params, [
    { name: 'TORRENT_CLIENT_SOFTWARE', value: 'qBittorrent' },
    { name: 'TORRENT_CLIENT_URL', value: QB_URL },
  ]);
  assert.deepEqual(w.fake.connectionStatus, { connected: true });
});

test('the states of a reading, then only what changed', async (t) => {
  const w = await world(t);
  const id = ids(w.gladys);
  assert.equal(w.fake.lastState(id.feature('torrents_downloading')), 3);
  assert.equal(w.fake.lastState(id.feature('torrents_paused')), 0);
  assert.equal(w.fake.lastState(id.feature('torrents_completed')), 0);
  assert.equal(w.fake.lastState(id.feature('free_space')), 31.8);
  assert.equal(w.fake.lastState(id.feature('alt_speed')), 0);
  assert.equal(w.fake.lastState(id.feature('connected')), 1);
  const text = w.fake.states.findLast(
    (s) => s.device_feature_external_id === id.feature('current_downloads'),
  );
  assert.equal(
    text.text,
    'Big Buck Bunny (2008) 0% · Debian-Netinst.iso 0% · Ubuntu-Test-Image.iso 0%',
  );

  const count = w.fake.states.length;
  await w.hub.pollAll();
  assert.equal(w.fake.states.length, count, 'nothing changed, nothing sent');

  w.qb.update(DEBIAN, { progress: 0.5, state: 'downloading', dlspeed: 680_000 });
  w.qb.server.dl_info_speed = 680_000;
  await w.hub.pollAll();
  const sent = w.fake.states.slice(count).map((s) => s.device_feature_external_id.split(':').pop());
  assert.deepEqual(sent.sort(), ['current_downloads', 'download_speed']);
  assert.equal(w.fake.lastState(id.feature('download_speed')), 680);
});

test('a device added in Gladys gets every state again, and the widget a refresh', async (t) => {
  const w = await world(t);
  const count = w.fake.states.length;
  const refreshes = w.fake.widgetRefreshes.length;
  await createAll(w);
  assert.equal(w.fake.states.length - count, 9, 'all nine features');
  assert.ok(w.fake.widgetRefreshes.length > refreshes);
});

test('an unchanged value is sent again after six hours (heartbeat)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 14) });
  const w = await world(t);
  const count = w.fake.states.length;
  t.mock.timers.tick(6 * 60 * 60_000);
  await w.hub.pollAll();
  assert.equal(w.fake.states.length - count, 9);
});

test('"Download completed": a torrent seen downloading, now complete', async (t) => {
  const w = await world(t);
  w.qb.update(UBUNTU, { progress: 0.6, state: 'downloading', category: 'linux' });
  await w.hub.pollAll();
  assert.deepEqual(w.fake.sceneEvents, []);
  w.qb.update(UBUNTU, { progress: 1, state: 'uploading', downloaded: 30_000_000 });
  await w.hub.pollAll();
  assert.deepEqual(w.fake.sceneEvents, [
    {
      key: TRIGGERS.COMPLETED,
      data: {
        device: ids(w.gladys).device,
        client: 'NAS',
        name: 'Ubuntu-Test-Image.iso',
        category: 'linux',
        size_gb: 0.03,
      },
    },
  ]);
  await w.hub.pollAll();
  assert.equal(w.fake.sceneEvents.length, 1, 'once');
});

test('"New torrent added": once its name is known, whoever added it', async (t) => {
  const w = await world(t, { config: { ...QB_CONFIG, allow_magnet: true } });
  const ack = await w.fake.sceneAction('add_magnet', { magnet: MAGNET });
  assert.deepEqual(ack, { success: true, data: { outputs: { hash: MAGNET.slice(20, 60) } } });
  assert.deepEqual(w.fake.sceneEvents, [], 'no name yet: metadata pending');
  w.qb.update(MAGNET.slice(20, 60), {
    name: 'Sintel',
    state: 'downloading',
    size: 2e9,
    total_size: 2e9,
  });
  await w.hub.pollAll();
  assert.deepEqual(
    w.fake.sceneEvents.map((e) => [e.key, e.data.name, e.data.size_gb]),
    [[TRIGGERS.ADDED, 'Sintel', 2]],
  );
});

test('a burst of new torrents fires a bounded number of events', async (t) => {
  const w = await world(t);
  for (let i = 0; i < 50; i += 1) {
    w.qb.update(`hash${i}`, {
      name: `T${i}`,
      progress: 0,
      state: 'queuedDL',
      size: 1,
      total_size: 1,
    });
  }
  await w.hub.pollAll();
  assert.equal(w.fake.sceneEvents.length, MAX_EVENTS_PER_READING);
});

test('a client that stops answering: disconnected, unreachable, then back', async (t) => {
  const w = await world(t, { config: THREE_CLIENTS });
  const id = ids(w.gladys);
  w.qb.online = false;
  await w.hub.pollAll();
  assert.equal(w.fake.lastState(id.feature('connected')), 0);
  assert.deepEqual(w.fake.transports.at(-1), {
    device_external_id: id.device,
    transport: 'unreachable',
  });
  const status = w.fake.connectionStatus;
  assert.equal(status.connected, true, 'two clients of three still answer');
  assert.equal(status.message.fr, 'NAS : ne répond pas');

  w.qb.online = true;
  await w.hub.pollAll();
  assert.equal(w.fake.lastState(id.feature('connected')), 1);
  assert.deepEqual(w.fake.connectionStatus, { connected: true });
});

test('a refused password is reported in the connection status', async (t) => {
  const w = await world(t, { config: { ...QB_CONFIG, client_1_password: 'wrong' } });
  assert.deepEqual(w.fake.connectionStatus, {
    connected: false,
    message: {
      en: 'NAS: user name or password refused',
      fr: "NAS : nom d'utilisateur ou mot de passe refusé",
      de: 'NAS: Benutzername oder Passwort abgelehnt',
      es: 'NAS: nombre de usuario o contraseña rechazados',
    },
  });
});

test('no client configured, or an address not understood', async (t) => {
  const w = await world(t, { config: {} });
  assert.equal(w.fake.connectionStatus.connected, false);
  assert.match(w.fake.connectionStatus.message.en, /Enter the address/);
  assert.deepEqual(w.fake.discoveredDevices, []);
  await w.fake.configUpdated({ client_1_url: 'ftp://192.0.2.10' });
  assert.match(w.fake.connectionStatus.message.en, /not understood/);
});

test('the alternative speed switch drives the client', async (t) => {
  const w = await world(t, { config: THREE_CLIENTS });
  await createAll(w);
  const device = w.fake.devices.find((d) => d.external_id === ids(w.gladys).device);
  const feature = device.features.find((f) => f.external_id.endsWith(':alt_speed'));
  assert.deepEqual(await w.fake.setValue(device, feature, 1), { success: true });
  assert.equal(w.qb.server.use_alt_speed_limits, true);
  assert.equal(w.fake.lastState(feature.external_id), 1);
  assert.equal(w.tr.session['alt-speed-enabled'], false, 'only that client');
  const connected = device.features.find((f) => f.external_id.endsWith(':connected'));
  assert.equal((await w.fake.setValue(device, connected, 1)).success, false);
});

test('scene actions: pause and resume every client, or one', async (t) => {
  const w = await world(t, { config: THREE_CLIENTS });
  let ack = await w.fake.sceneAction('pause_all', {});
  assert.deepEqual(ack.data.outputs, { clients: 3 });
  const paused = w.fake.lastState(ids(w.gladys, 'deluge', 3).feature('torrents_paused'));
  assert.ok(paused >= 1);
  ack = await w.fake.sceneAction('resume_all', { device: ids(w.gladys, 'transmission', 2).device });
  assert.deepEqual(ack.data.outputs, { clients: 1 });
  assert.ok(w.tr.torrents.every((t) => t.status !== 0));
  assert.ok(Object.values(w.qb.torrents).every((t) => t.state.startsWith('paused')));
});

test('scene actions: alternative speed on the clients that have it', async (t) => {
  const w = await world(t, { config: THREE_CLIENTS });
  let ack = await w.fake.sceneAction('set_alt_speed', { state: 'on' });
  assert.deepEqual(ack.data.outputs, { clients: 2 }, 'Deluge skipped');
  assert.equal(w.qb.server.use_alt_speed_limits, true);
  assert.equal(w.tr.session['alt-speed-enabled'], true);
  await w.fake.sceneAction('set_alt_speed', { state: 'off', device: ids(w.gladys).device });
  assert.equal(w.qb.server.use_alt_speed_limits, false);
  ack = await w.fake.sceneAction('set_alt_speed', {
    state: 'on',
    device: ids(w.gladys, 'deluge', 3).device,
  });
  assert.equal(ack.success, false);
  assert.match(ack.error, /Deluge and rTorrent have no alternative speed limits/);
});

test('scene actions: a magnet link only when allowed, and only a magnet link', async (t) => {
  const w = await world(t);
  let ack = await w.fake.sceneAction('add_magnet', { magnet: MAGNET });
  assert.equal(ack.success, false);
  assert.match(ack.error, /Adding torrents is off/);
  await w.fake.configUpdated({ ...QB_CONFIG, allow_magnet: true });
  ack = await w.fake.sceneAction('add_magnet', { magnet: 'https://192.0.2.1/file.torrent' });
  assert.match(ack.error, /not a magnet link/);
  ack = await w.fake.sceneAction('add_magnet', { magnet: MAGNET });
  assert.equal(ack.success, true);
  ack = await w.fake.sceneAction('add_magnet', { magnet: MAGNET });
  assert.equal(ack.success, false);
  assert.match(ack.error, /NAS: command refused by the client/);
});

test('a client unknown to the configuration is refused', async (t) => {
  const w = await world(t);
  const ack = await w.fake.sceneAction('pause_all', { device: ids(w.gladys, 'deluge', 3).device });
  assert.equal(ack.success, false);
  assert.match(ack.error, /no longer in the configuration/);
});

test('"Test the connection" reads every client now and reports each', async (t) => {
  const w = await world(t, { config: { ...THREE_CLIENTS, client_3_password: 'wrong' } });
  const ack = await w.fake.action('test_connection', {});
  assert.equal(ack.success, true);
  assert.deepEqual(ack.data.message.en.split('\n'), [
    'NAS: OK, qBittorrent 4.6.3, 3 in progress out of 3 torrents',
    'Transmission 192.0.2.11:9091: OK, Transmission 4.0.5, 1 in progress out of 4 torrents',
    'Deluge 198.51.100.12:8112: user name or password refused',
  ]);
});

test('a new configuration: removed client, other language', async (t) => {
  const w = await world(t, { config: THREE_CLIENTS });
  await createAll(w);
  const text = () =>
    w.fake.states.findLast(
      (s) => s.device_feature_external_id === ids(w.gladys).feature('current_downloads'),
    ).text;
  assert.match(text(), /0% ·/);
  await w.fake.configUpdated({ ...QB_CONFIG, language: 'fr' });
  assert.equal(w.fake.discoveredDevices.length, 1);
  assert.match(text(), /0\u202f% ·/);
  assert.equal(w.fake.discoveredDevices[0].features[0].name, 'Débit descendant');
});

test('Gladys restarted: everything is sent again', async (t) => {
  const w = await world(t);
  const count = w.fake.states.length;
  await w.gladys.disconnect();
  await w.gladys.connect();
  assert.equal(w.fake.states.length - count, 9);
});

test('never a request that deletes a torrent or its data', async (t) => {
  const w = await world(t, { config: { ...THREE_CLIENTS, allow_magnet: true } });
  for (const key of ['pause_all', 'resume_all']) {
    await w.fake.sceneAction(key, {});
  }
  await w.fake.sceneAction('set_alt_speed', { state: 'on' });
  await w.fake.sceneAction('add_magnet', { magnet: MAGNET });
  await w.fake.widgetAction('torrents', 'pause_all', {}, { settings: {} });
  await w.app.stop();
  const sent = w.network.requests.map((r) => `${r.url} ${r.options.body ?? ''}`).join('\n');
  // qBittorrent torrents/delete, Transmission torrent-remove, Deluge core.remove_torrent(s),
  // rTorrent d.erase.
  assert.doesNotMatch(
    sent,
    /torrents\/delete|torrent-remove|remove_torrent|deleteFiles|delete-local-data|d\.erase/i,
  );
});

test('rTorrent: a device like Deluge (no alternative speed), its states, pause and resume', async (t) => {
  const w = await world(t, { config: { ...WITH_RTORRENT, allow_magnet: true } });
  const rtorrent = ids(w.gladys, 'rtorrent', 3);
  const device = w.fake.discoveredDevices.find((d) => d.external_id === rtorrent.device);
  assert.equal(device.name, 'rTorrent 198.51.100.13');
  assert.deepEqual(device.params, [
    { name: 'TORRENT_CLIENT_SOFTWARE', value: 'rTorrent' },
    { name: 'TORRENT_CLIENT_URL', value: RT_URL },
  ]);
  assert.deepEqual(
    device.features.map((f) => f.external_id.split(':').pop()),
    [
      'download_speed',
      'upload_speed',
      'torrents_downloading',
      'torrents_paused',
      'torrents_completed',
      'current_downloads',
      'free_space',
      'connected',
    ],
  );
  await createAll(w);
  assert.equal(w.fake.lastState(rtorrent.feature('torrents_completed')), 3);
  assert.equal(w.fake.lastState(rtorrent.feature('torrents_downloading')), 2);
  assert.equal(w.fake.lastState(rtorrent.feature('free_space')), 42.9);
  assert.equal(w.fake.lastState(rtorrent.feature('connected')), 1);

  let ack = await w.fake.sceneAction('pause_all', { device: rtorrent.device });
  assert.deepEqual(ack.data.outputs, { clients: 1 });
  assert.equal(
    w.fake.lastState(rtorrent.feature('torrents_paused')),
    1,
    'the download in progress',
  );
  ack = await w.fake.sceneAction('resume_all', { device: rtorrent.device });
  assert.equal(ack.success, true);
  assert.equal(w.fake.lastState(rtorrent.feature('torrents_paused')), 0);

  ack = await w.fake.sceneAction('set_alt_speed', { state: 'on' });
  assert.deepEqual(ack.data.outputs, { clients: 2 }, 'rTorrent skipped');
  ack = await w.fake.sceneAction('set_alt_speed', { state: 'on', device: rtorrent.device });
  assert.match(ack.error, /Deluge and rTorrent have no alternative speed limits/);

  ack = await w.fake.sceneAction('add_magnet', { magnet: MAGNET, device: rtorrent.device });
  assert.equal(ack.success, true);
  assert.ok(w.rt.torrents.has('0123456789ABCDEF0123456789ABCDEF01234567'));

  const report = await w.fake.action('test_connection', {});
  assert.match(report.data.message.en, /rTorrent 198\.51\.100\.13: OK, rTorrent 0\.16\.25, /);
  await w.app.stop();
  const sent = w.network.requests.map((r) => `${r.url} ${r.options.body ?? ''}`).join('\n');
  assert.doesNotMatch(sent, /d\.erase|torrents\/delete|torrent-remove|remove_torrent/);
});

test('rTorrent: a refused password is reported, the other clients go on', async (t) => {
  const w = await world(t, { config: { ...WITH_RTORRENT, client_3_password: 'wrong' } });
  const ack = await w.fake.action('test_connection', {});
  assert.equal(
    ack.data.message.en.split('\n')[2],
    'rTorrent 198.51.100.13: user name or password refused',
  );
  await createAll(w);
  assert.equal(w.fake.lastState(ids(w.gladys, 'rtorrent', 3).feature('connected')), 0);
  assert.equal(w.fake.lastState(ids(w.gladys).feature('connected')), 1);
});
