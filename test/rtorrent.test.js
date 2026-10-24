// -----------------------------------------------------------------------------
// The rTorrent client against its fake (test/helpers/fakeClients.js) and the
// answers recorded on rTorrent 0.16.25 (crazymax/rtorrent-rutorrent, nginx
// in front, with and without HTTP Basic): a seeding torrent with a ruTorrent
// label, a paused one (d.pause), a stopped one (d.stop), one whose file was
// deleted (stopped by rTorrent with a message), one downloading, and a
// magnet link waiting for its metadata (test/fixtures/rtorrent/).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RtorrentClient, freeSpaceOf, rpcUrl, toTorrent } from '../src/clients/rtorrent.js';
import { ERROR_KINDS, LOGIN_BACKOFF_MS } from '../src/clients/common.js';
import { countTorrents } from '../src/model.js';
import { FakeRtorrent, createNetwork, rtorrentFixture } from './helpers/fakeClients.js';
import { createClock } from './helpers/world.js';

const RT = 'http://192.0.2.13';
const MAGNET = 'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny';
const [SEED, PAUSED, BROKEN, LEECH, STOPPED] = [
  '60148BFB08F1384420E8C6CA83D334C6E064624D',
  '276951AA066C690EF8C52FB0608D25F1F1A4B14E',
  'FFE11194537703EBCE121E4B75CAEE32F907C953',
  'AB66C3888E26B02E11E03F5B6C8896083A24732F',
  '65E8E6DD3C22F8CA228457682859F7721490C036',
];

function rt(options = {}, clientOptions = {}) {
  const server = new FakeRtorrent(options);
  const network = createNetwork({ [RT]: server });
  const client = new RtorrentClient({ url: RT, request: network.request, ...clientOptions });
  return { server, network, client };
}

const byName = (reading) =>
  Object.fromEntries(reading.torrents.map((t) => [t.name.replace(/^gladys-test-|\.bin$/g, ''), t]));

test('rTorrent: the XML-RPC address', () => {
  assert.equal(rpcUrl('http://192.0.2.13'), 'http://192.0.2.13/RPC2');
  assert.equal(rpcUrl('http://192.0.2.13:8000/'), 'http://192.0.2.13:8000/RPC2');
  assert.equal(rpcUrl('https://seedbox.example/user/RPC2'), 'https://seedbox.example/user/RPC2');
  assert.equal(rpcUrl('https://seedbox.example/rpc2/'), 'https://seedbox.example/rpc2');
  assert.equal(
    rpcUrl('https://seedbox.example/rutorrent'),
    'https://seedbox.example/rutorrent/RPC2',
  );
  assert.equal(
    rpcUrl('https://seedbox.example/rutorrent/plugins/rpc/rpc.php'),
    'https://seedbox.example/rutorrent/plugins/rpc/rpc.php',
  );
});

test('rTorrent 0.16.25: every state of the recorded answer', async () => {
  const { client, network } = rt();
  const reading = await client.read();
  assert.equal(network.requests.length, 1, 'one system.multicall per reading');
  assert.equal(reading.version, '0.16.25');
  assert.equal(reading.altSpeed, null);
  assert.equal(reading.freeSpace, 42932940800);
  const t = byName(reading);
  assert.deepEqual(
    [t.seed.complete, t.seed.paused, t.seed.category, t.seed.hash],
    [true, false, 'Films HD', SEED.toLowerCase()],
  );
  assert.deepEqual([t.paused.complete, t.paused.paused], [true, true], 'd.pause');
  assert.deepEqual([t.stopped.complete, t.stopped.paused], [true, true], 'd.stop');
  assert.deepEqual(
    [t.broken.error, t.broken.paused, t.broken.complete, t.broken.downloading],
    [true, false, false, false],
    'stopped by rTorrent after its file went missing: in error, not paused',
  );
  assert.deepEqual([t.leech.downloading, t.leech.progress, t.leech.size], [true, 0, 3000000]);
  assert.equal(t.leech.addedAt, 1792852240000);
  assert.deepEqual(countTorrents(reading.torrents), {
    downloading: 2,
    paused: 0,
    completed: 3,
    total: 5,
  });
});

test('rTorrent: a magnet link without metadata, a tracker message is not an error', async () => {
  const { client } = rt({ recorded: 'read-0.16.25-magnet.xml' });
  const reading = await client.read();
  const magnet = reading.torrents.find((t) => t.name.endsWith('.meta'));
  assert.deepEqual(
    [magnet.hasMetadata, magnet.complete, magnet.size, magnet.error, magnet.downloading],
    [false, false, null, false, true],
  );
  // The magnet's own folder is the session one: the free space is read from a
  // torrent of the default directory.
  assert.equal(reading.freeSpace, 42711044096);
});

test('rTorrent before 0.9.7: read again without d.is_meta and d.load_date', async () => {
  const { client, server } = rt({ legacy: true });
  await client.addMagnet(MAGNET);
  server.legacy = true;
  const reading = await client.read();
  assert.equal(reading.torrents.length, 6);
  const magnet = reading.torrents.find((t) => t.name.endsWith('.meta'));
  assert.equal(magnet.hasMetadata, false, 'recognized by its name');
  assert.equal(magnet.addedAt, null);
  await client.read();
  const multicalls = server.requests.filter((r) => r.method === 'd.multicall2').length;
  assert.equal(multicalls, 3, 'the shorter field list is kept');
});

test('rTorrent: free space from a torrent of the default directory, else the first, else none', () => {
  const fields = ['d.free_diskspace=', 'd.directory='];
  const rows = [
    [10, '/data/rtorrent/.session'],
    [20, '/downloads/temp/Show'],
  ];
  assert.equal(freeSpaceOf(rows, fields, '/downloads/temp/'), 20);
  assert.equal(freeSpaceOf(rows, fields, '/elsewhere'), 10);
  assert.equal(freeSpaceOf(rows, fields, ''), 10);
  assert.equal(freeSpaceOf([], fields, '/downloads/temp/'), null);
  assert.equal(freeSpaceOf([[-1, '/x']], fields, ''), null);
});

test('rTorrent: a row missing fields or a label badly encoded', () => {
  const [, , , , [rows]] = rtorrentFixture();
  const row = [...rows[0]];
  row[11] = '100%_sure';
  assert.equal(toTorrent(row).category, '100%_sure');
  row[1] = '';
  assert.equal(toTorrent(row).name, SEED.toLowerCase());
});

test('rTorrent: pause stops every started torrent, resume starts or resumes each', async () => {
  const { client, server } = rt();
  await client.pauseAll();
  const states = () => [...server.torrents.values()].map((t) => [t['d.state='], t['d.is_active=']]);
  assert.deepEqual(states(), [
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
  ]);
  server.update(PAUSED, { 'd.state=': 1, 'd.is_active=': 0 }); // paused in ruTorrent
  await client.resumeAll();
  assert.ok(states().every(([state, active]) => state === 1 && active === 1));
  const sent = server.requests.map((r) => r.method);
  assert.ok(sent.includes('d.resume') && sent.includes('d.start') && sent.includes('d.stop'));
  assert.ok(!sent.some((m) => /erase|delete|remove/.test(m)), 'never deletes');
  for (const hash of [SEED, BROKEN, LEECH, STOPPED]) {
    assert.ok(server.torrents.has(hash));
  }
});

test('rTorrent: nothing to pause, no command sent', async () => {
  const { client, server } = rt();
  server.torrents.clear();
  await client.pauseAll();
  await client.resumeAll();
  assert.deepEqual(
    server.requests.map((r) => r.method),
    ['d.multicall2', 'd.multicall2'],
  );
});

test('rTorrent: add a magnet link, no alternative speed', async () => {
  const { client, server } = rt();
  assert.deepEqual(await client.addMagnet(MAGNET), {
    hash: 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c',
  });
  assert.ok(server.torrents.has('DD8255ECDC7CA55FB0BBF81323D87062DB1F6D1C'));
  await assert.rejects(client.addMagnet('https://192.0.2.1/x.torrent'), {
    kind: ERROR_KINDS.REJECTED,
  });
  assert.equal(client.supportsAltSpeed, false);
  await assert.rejects(client.setAltSpeed(true), { kind: ERROR_KINDS.UNSUPPORTED });
  await client.logout();
});

test('rTorrent: HTTP Basic, missing or refused, with the login back-off', async () => {
  const clock = createClock();
  const options = { username: 'gladys', password: 'secret' };
  let { client } = rt(options, { now: clock.now });
  let network;
  await assert.rejects(client.read(), {
    kind: ERROR_KINDS.AUTH,
    message: 'The web server asks for a login',
  });

  ({ client, network } = rt(options, { username: 'gladys', password: 'wrong', now: clock.now }));
  await assert.rejects(client.read(), { kind: ERROR_KINDS.AUTH });
  await assert.rejects(client.read(), { kind: ERROR_KINDS.AUTH });
  assert.equal(network.requests.length, 1, 'not tried again during the back-off');
  await assert.rejects(client.read({ force: true }), { kind: ERROR_KINDS.AUTH });
  assert.equal(network.requests.length, 2, '"Test the connection" tries at once');
  clock.advance(LOGIN_BACKOFF_MS[1] + 1);
  network.servers[RT].password = 'wrong';
  const reading = await client.read();
  assert.equal(reading.torrents.length, 5);
  assert.ok(!JSON.stringify(network.requests).includes('wrong'), 'only the Basic header');

  ({ client, network } = rt(options, { ...options }));
  await client.read();
  assert.match(network.requests[0].options.headers.authorization, /^Basic /);
});

test('rTorrent: wrong address, not XML-RPC, a fault, unreachable', async () => {
  const { client, server, network } = rt();
  const at = (url) => new RtorrentClient({ url, request: network.request });
  await assert.rejects(at(`${RT}/rutorrent/plugins/httprpc/action.php`).read(), {
    kind: ERROR_KINDS.NOT_FOUND,
  });
  server.handle = () => ({ status: 200, headers: {}, body: '<html>ruTorrent</html>' });
  await assert.rejects(client.read(), { kind: ERROR_KINDS.NOT_FOUND });
  server.handle = () => ({ status: 502, headers: {}, body: 'Bad Gateway' });
  await assert.rejects(client.read(), { kind: ERROR_KINDS.HTTP, status: 502 });
  delete server.handle;
  server.dispatch = () => {
    throw Object.assign(new Error('Could not find info-hash.'), { code: -501 });
  };
  await assert.rejects(client.read(), { kind: ERROR_KINDS.REJECTED });
  server.online = false;
  await assert.rejects(client.read(), { kind: ERROR_KINDS.UNREACHABLE });
});

test('rTorrent: a fault inside the multicall is refused, not taken for a reading', async () => {
  const { client, server } = rt();
  const dispatch = server.dispatch.bind(server);
  server.dispatch = (method, params) => {
    if (method === 'directory.default') {
      throw Object.assign(new Error('Permission denied'), { code: -500 });
    }
    return dispatch(method, params);
  };
  await assert.rejects(client.read(), {
    kind: ERROR_KINDS.REJECTED,
    message: 'directory.default: Permission denied',
  });
});
