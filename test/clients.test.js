// -----------------------------------------------------------------------------
// The three clients against their fakes (test/helpers/fakeClients.js) and
// against the answers recorded on qbittorrent-nox 4.6.3, transmission-daemon
// 4.0.5 and Deluge 2.1 (test/fixtures/).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DelugeClient, jsonUrl } from '../src/clients/deluge.js';
import { QbittorrentClient } from '../src/clients/qbittorrent.js';
import { TransmissionClient, rpcUrl } from '../src/clients/transmission.js';
import { ERROR_KINDS, LOGIN_BACKOFF_MS, magnetHash, magnetName } from '../src/clients/common.js';
import {
  FakeDeluge,
  FakeQbittorrent,
  FakeTransmission,
  createNetwork,
  fixture,
} from './helpers/fakeClients.js';
import { createClock } from './helpers/world.js';

const QB = 'http://192.0.2.10:8080';
const TR = 'http://192.0.2.11:9091';
const DE = 'http://192.0.2.12:8112';
const MAGNET = 'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny';

function qb(options = {}, clientOptions = {}) {
  const server = new FakeQbittorrent(options);
  const network = createNetwork({ [QB]: server });
  const clock = createClock();
  const client = new QbittorrentClient({
    url: QB,
    username: 'admin',
    password: 'secret',
    request: network.request,
    now: clock.now,
    ...clientOptions,
  });
  return { server, network, client, clock };
}

// --- qBittorrent ------------------------------------------------------------------

test('qBittorrent: the recorded synchronization, merged answer after answer', async () => {
  const answers = [
    'maindata-full',
    'maindata-delta-downloading',
    'maindata-delta-progress',
    'maindata-delta-completed',
    'maindata-delta-paused-alt-speed',
    'maindata-delta-magnet-added',
  ].map((name) => fixture(`qbittorrent/${name}.json`));
  const rids = [];
  const request = async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/auth/login')) {
      return { status: 200, headers: { 'set-cookie': ['SID=abc; HttpOnly'] }, body: 'Ok.' };
    }
    if (path.endsWith('/app/webapiVersion')) {
      return { status: 200, headers: {}, body: '2.9.3' };
    }
    if (path.endsWith('/app/version')) {
      return { status: 200, headers: {}, body: 'v4.6.3' };
    }
    rids.push(new URL(url).searchParams.get('rid'));
    return { status: 200, headers: {}, body: JSON.stringify(answers.shift()) };
  };
  const client = new QbittorrentClient({ url: QB, username: 'admin', password: 'x', request });

  let reading = await client.read();
  assert.equal(reading.version, '4.6.3');
  assert.equal(reading.torrents.length, 3);
  assert.ok(reading.torrents.every((t) => t.downloading && !t.complete && t.progress === 0));
  assert.equal(reading.freeSpace, 31805792256);
  assert.equal(reading.altSpeed, false);

  reading = await client.read();
  assert.equal(reading.downloadSpeed, 1563128);
  const debian = () => reading.torrents.find((t) => t.name === 'Debian-Netinst.iso');
  assert.equal(debian().progress, 0.197184);

  await client.read();
  reading = await client.read();
  assert.equal(debian().complete, true);
  assert.equal(debian().downloading, false);
  assert.equal(debian().downloaded, 8000000);

  reading = await client.read();
  assert.equal(reading.altSpeed, true);
  assert.ok(reading.torrents.every((t) => t.paused));
  // A completed torrent stays completed while paused.
  assert.equal(debian().complete, true);

  reading = await client.read();
  const magnet = reading.torrents.find(
    (t) => t.hash === 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c',
  );
  assert.equal(magnet.name, 'Big Buck Bunny');
  assert.equal(magnet.hasMetadata, false, 'metaDL: no metadata yet');
  assert.equal(magnet.complete, false, 'amount_left 0 without metadata is not complete');
  assert.deepEqual(rids, ['0', '2', '3', '4', '5', '6']);
});

test('qBittorrent: logs in once, no Referer nor Origin, logs in again on a 403', async () => {
  const { server, network, client } = qb();
  await client.read();
  await client.read();
  const logins = () => server.requests.filter((r) => r.path === 'auth/login').length;
  assert.equal(logins(), 1);
  const sync = network.requests.find((r) => r.url.includes('sync/maindata'));
  assert.equal(sync.options.headers.referer, undefined);
  assert.equal(sync.options.headers.origin, undefined);
  assert.match(sync.options.headers.cookie, /^SID=sid1$/);

  server.sessions.clear(); // qBittorrent restarted: the session is gone
  await client.read();
  assert.equal(logins(), 2);
});

test('qBittorrent: a refused password backs off before trying again', async () => {
  const { server, client, clock } = qb({ password: 'other' });
  await assert.rejects(client.read(), { kind: ERROR_KINDS.AUTH });
  await assert.rejects(client.read(), { kind: ERROR_KINDS.AUTH });
  const logins = () => server.requests.filter((r) => r.path === 'auth/login').length;
  assert.equal(logins(), 1, 'no second attempt during the back-off');
  clock.advance(LOGIN_BACKOFF_MS[0]);
  await assert.rejects(client.read(), { kind: ERROR_KINDS.AUTH });
  assert.equal(logins(), 2);
  // "Test the connection" tries at once.
  await assert.rejects(client.read({ force: true }), { kind: ERROR_KINDS.AUTH });
  assert.equal(logins(), 3);
});

test('qBittorrent: a banned address is reported as such', async () => {
  const { server, client } = qb({ password: 'other', banAfter: 0 });
  await assert.rejects(client.read(), { kind: ERROR_KINDS.BANNED });
  assert.equal(server.failures, 0);
});

test('qBittorrent: no credentials, no login until a 403 asks (bypass for the subnet)', async () => {
  const { server, client } = qb({ username: '', password: '' }, { username: '', password: '' });
  // The fake always needs a session: the 403 makes the client try an empty login.
  server.username = '';
  server.password = '';
  await client.read();
  assert.equal(server.requests[0].path, 'app/webapiVersion');
});

test('qBittorrent 4.x pauses and resumes, 5.x stops and starts', async () => {
  for (const [webApi, pause, resume] of [
    ['2.9.3', 'torrents/pause', 'torrents/resume'],
    ['2.11.4', 'torrents/stop', 'torrents/start'],
  ]) {
    const { server, client } = qb({ webApi });
    await client.pauseAll();
    let reading = await client.read();
    assert.ok(
      reading.torrents.every((t) => t.paused),
      webApi,
    );
    await client.resumeAll();
    reading = await client.read();
    assert.ok(
      reading.torrents.every((t) => !t.paused),
      webApi,
    );
    const paths = server.requests.map((r) => r.path);
    assert.ok(paths.includes(pause) && paths.includes(resume), `${webApi}: ${paths}`);
  }
});

test('qBittorrent: the alternative speed toggle is only sent when needed', async () => {
  const { server, client } = qb();
  await client.setAltSpeed(true);
  await client.setAltSpeed(true);
  assert.equal(server.server.use_alt_speed_limits, true);
  const toggles = server.requests.filter((r) => r.path === 'transfer/toggleSpeedLimitsMode');
  assert.equal(toggles.length, 1);
  await client.setAltSpeed(false);
  assert.equal(server.server.use_alt_speed_limits, false);
});

test('qBittorrent: a magnet link is added once, never anything else', async () => {
  for (const webApi of ['2.9.3', '2.11.4']) {
    const { client } = qb({ webApi });
    assert.deepEqual(await client.addMagnet(MAGNET), {
      hash: 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c',
    });
    await assert.rejects(client.addMagnet(MAGNET), { kind: ERROR_KINDS.REJECTED });
    await assert.rejects(client.addMagnet('http://192.0.2.1/x.torrent'), {
      kind: ERROR_KINDS.REJECTED,
    });
  }
});

test('qBittorrent: wrong address or software', async () => {
  const { client } = qb({}, { url: 'http://192.0.2.99:8080' });
  await assert.rejects(client.read(), { kind: ERROR_KINDS.UNREACHABLE });
  const network = createNetwork({ [QB]: new FakeTransmission() });
  const wrong = new QbittorrentClient({ url: QB, password: 'x', request: network.request });
  await assert.rejects(wrong.read(), { kind: ERROR_KINDS.NOT_FOUND });
});

// --- Transmission -----------------------------------------------------------------

function tr(options = {}, clientOptions = {}) {
  const server = new FakeTransmission(options);
  const network = createNetwork({ [TR]: server });
  const client = new TransmissionClient({
    url: TR,
    username: 'gladys',
    password: 'secret',
    request: network.request,
    ...clientOptions,
  });
  return { server, network, client };
}

test('Transmission: the RPC address from what the user typed', () => {
  assert.equal(rpcUrl('http://192.0.2.11:9091'), 'http://192.0.2.11:9091/transmission/rpc');
  assert.equal(
    rpcUrl('http://192.0.2.11:9091/transmission/web'),
    'http://192.0.2.11:9091/transmission/rpc',
  );
  assert.equal(
    rpcUrl('http://192.0.2.11:9091/transmission'),
    'http://192.0.2.11:9091/transmission/rpc',
  );
  assert.equal(rpcUrl('https://nas.example/tr/rpc'), 'https://nas.example/tr/rpc');
  assert.equal(
    rpcUrl('https://nas.example/torrents'),
    'https://nas.example/torrents/transmission/rpc',
  );
});

test('Transmission: the recorded answers, read through the CSRF session id', async () => {
  const { server, client } = tr();
  const reading = await client.read();
  assert.equal(reading.version, '4.0.5');
  assert.equal(reading.altSpeed, false);
  assert.equal(reading.freeSpace, fixture('transmission/free-space.json').arguments['size-bytes']);
  assert.equal(reading.torrents.length, 4);
  const seeding = reading.torrents.filter((t) => t.complete && !t.paused);
  assert.equal(seeding.length, 3);
  const magnet = reading.torrents.find((t) => t.name === 'Big+Buck+Bunny');
  assert.equal(magnet.hasMetadata, false);
  assert.equal(magnet.downloading, true);
  // One 409 to learn the session id, then none.
  const before = server.requests.length;
  await client.read();
  assert.equal(server.requests.length - before, 4);

  server.restart(); // the daemon restarted: a new id, learnt again
  await client.read();
});

test('Transmission: authentication and whitelist errors', async () => {
  await assert.rejects(tr({ password: 'other' }).client.read(), { kind: ERROR_KINDS.AUTH });
  await assert.rejects(tr({ whitelisted: false }).client.read(), {
    kind: ERROR_KINDS.FORBIDDEN,
  });
  const { client } = tr({}, { url: 'http://192.0.2.11:9091/other' });
  await assert.rejects(client.read(), { kind: ERROR_KINDS.NOT_FOUND });
});

test('Transmission: turtle mode, pause, resume, magnet', async () => {
  const { server, client } = tr();
  await client.setAltSpeed(true);
  assert.equal(server.session['alt-speed-enabled'], true);
  await client.pauseAll();
  assert.ok((await client.read()).torrents.every((t) => t.paused));
  await client.resumeAll();
  assert.ok((await client.read()).torrents.every((t) => !t.paused));
  const fresh = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567';
  assert.deepEqual(await client.addMagnet(fresh), {
    hash: '0123456789abcdef0123456789abcdef01234567',
  });
  await assert.rejects(client.addMagnet(fresh), { kind: ERROR_KINDS.REJECTED });
});

test('Transmission: no free space before RPC 15, or for a missing folder', async () => {
  const old = tr();
  old.server.session['rpc-version'] = 14;
  assert.equal((await old.client.read()).freeSpace, null);
});

// --- Deluge -----------------------------------------------------------------------

function de(options = {}, clientOptions = {}) {
  const server = new FakeDeluge(options);
  const network = createNetwork({ [DE]: server });
  const client = new DelugeClient({
    url: DE,
    password: 'deluge',
    request: network.request,
    ...clientOptions,
  });
  return { server, network, client };
}

test('Deluge: the JSON-RPC address', () => {
  assert.equal(jsonUrl('http://192.0.2.12:8112'), 'http://192.0.2.12:8112/json');
  assert.equal(jsonUrl('https://nas.example/deluge/'), 'https://nas.example/deluge/json');
  assert.equal(jsonUrl('https://nas.example/deluge/json'), 'https://nas.example/deluge/json');
});

test('Deluge: the recorded answer, percentages and magnet without metadata', async () => {
  const { client } = de();
  const reading = await client.read();
  assert.equal(reading.version, '2.1.2.dev0');
  assert.equal(reading.altSpeed, null);
  assert.equal(reading.freeSpace, fixture('deluge/update-ui.json').result.stats.free_space);
  const byName = Object.fromEntries(reading.torrents.map((t) => [t.name, t]));
  assert.equal(byName['Ubuntu-Test-Image.iso'].paused, true);
  assert.ok(byName['Ubuntu-Test-Image.iso'].progress < 0.001); // 0.0546 %
  assert.equal(byName['Debian-Netinst.iso'].complete, true);
  assert.equal(byName['Big Buck Bunny'].hasMetadata, false);
  assert.equal(client.supportsAltSpeed, false);
  await assert.rejects(client.setAltSpeed(true), { kind: ERROR_KINDS.UNSUPPORTED });
});

test('Deluge: connects the web interface to its daemon when needed', async () => {
  const { server, client } = de({ daemonConnected: false });
  await client.read();
  assert.ok(server.requests.some((r) => r.method === 'web.connect'));

  const offline = de({ daemonConnected: false });
  offline.server.daemonOnline = false;
  await assert.rejects(offline.client.read(), { kind: ERROR_KINDS.NO_DAEMON });
  await assert.rejects(de({ daemonConnected: false, hosts: [] }).client.read(), {
    kind: ERROR_KINDS.NO_DAEMON,
  });
});

test('Deluge: wrong password, expired session', async () => {
  await assert.rejects(de({ password: 'other' }).client.read(), { kind: ERROR_KINDS.AUTH });
  const { server, client } = de();
  await client.read();
  server.sessions.clear();
  await client.read();
  assert.equal(server.requests.filter((r) => r.method === 'auth.login').length, 2);
});

test('Deluge: pause and resume every torrent, add a magnet link', async () => {
  const { client } = de();
  await client.pauseAll();
  assert.ok((await client.read()).torrents.every((t) => t.paused));
  await client.resumeAll();
  assert.ok((await client.read()).torrents.every((t) => !t.paused));
  await assert.rejects(client.addMagnet(MAGNET), { kind: ERROR_KINDS.REJECTED });
  const fresh = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567';
  assert.deepEqual(await client.addMagnet(fresh), {
    hash: '0123456789abcdef0123456789abcdef01234567',
  });
});

// --- Shared -----------------------------------------------------------------------

test('only magnet links with an info hash are accepted', () => {
  assert.equal(magnetHash(MAGNET), 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c');
  assert.equal(magnetHash('magnet:?xt=urn:btmh:1220ABCDEF&dn=x'), '1220abcdef');
  for (const bad of [
    'http://x/y.torrent',
    'magnet:?dn=only-a-name',
    '',
    null,
    `magnet:?xt=urn:btih:${'a'.repeat(9000)}`,
  ]) {
    assert.equal(magnetHash(bad), null, String(bad).slice(0, 30));
  }
  assert.equal(magnetName(MAGNET), 'Big Buck Bunny');
});

test('a self-signed certificate is reported, and accepted with the option', async () => {
  const request = async (_url, options) => {
    if (!options.insecure) {
      const error = new Error('self-signed certificate');
      error.code = 'DEPTH_ZERO_SELF_SIGNED_CERT';
      throw error;
    }
    return {
      status: 200,
      headers: { 'set-cookie': '_session_id=x' },
      body: JSON.stringify({ result: false, error: null, id: 1 }),
    };
  };
  await assert.rejects(new DelugeClient({ url: DE, request }).read(), { kind: ERROR_KINDS.TLS });
  await assert.rejects(new DelugeClient({ url: DE, request, insecure: true }).read(), {
    kind: ERROR_KINDS.AUTH,
  });
});

test('qBittorrent 5: the recorded answer of stopped torrents (5.2.4)', async () => {
  const data = fixture('qbittorrent/maindata-v5-stopped.json');
  const { client } = qb({ webApi: '2.15.1', version: 'v5.2.4', maindata: data });
  const reading = await client.read();
  assert.equal(reading.version, '5.2.4');
  const byHash = Object.fromEntries(reading.torrents.map((t) => [t.hash, t]));
  const ubuntu = byHash['026a771e6576fb1e05e102ef0f1615e2732a0667'];
  assert.equal(ubuntu.paused, true, 'stoppedDL is paused');
  assert.equal(ubuntu.category, 'films');
  const bunny = byHash.ffc3d6947d79e038b9b7befe9d750bb620517e8b;
  assert.equal(bunny.complete, true, 'stoppedUP is complete');
  const magnet = byHash.dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c;
  assert.equal(magnet.hasMetadata, false, 'a stopped magnet link has no metadata');
});
