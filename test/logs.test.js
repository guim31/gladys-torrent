// -----------------------------------------------------------------------------
// What the integration writes at the default level (info): the lifecycle
// only. A normal reading writes nothing, a failure that repeats is logged
// once, and its end once. Never a password, a user name or a session cookie.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QB_CONFIG, THREE_CLIENTS, createWorld } from './helpers/world.js';

/** Capture the lines of the SDK logger at LOG_LEVEL=info. */
function captureLogs(t, level = 'info') {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = level;
  t.after(() => {
    process.env.LOG_LEVEL = previous;
  });
  const lines = [];
  const record =
    (stream) =>
    (...args) =>
      lines.push({
        stream,
        text: args.map((arg) => (arg instanceof Error ? arg.stack : String(arg))).join(' '),
      });
  t.mock.method(console, 'log', record('out'));
  t.mock.method(console, 'error', record('err'));
  t.mock.method(console, 'warn', record('err'));
  return {
    lines,
    clear: () => lines.splice(0),
    texts: () => lines.map((line) => line.text),
  };
}

async function world(t, options) {
  const w = await createWorld(options);
  t.after(() => w.app.stop());
  return w;
}

const DEBIAN = 'f0f72a7a266aba79d6c5e031c93813ce733c6996';

test('a normal reading cycle writes nothing at info', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t, { config: THREE_CLIENTS });
  assert.equal(logs.texts().filter((text) => text.includes('connected to')).length, 3);
  logs.clear();

  for (let i = 1; i <= 5; i += 1) {
    w.qb.update(DEBIAN, { progress: i / 10, state: 'downloading', dlspeed: 1000 * i });
    w.qb.server.dl_info_speed = 1000 * i;
    await w.hub.pollAll();
  }
  // Completed and added torrents are scene events, not log lines.
  w.qb.update(DEBIAN, { progress: 1, state: 'uploading' });
  w.qb.update('new', { name: 'New', progress: 0, state: 'downloading', size: 5, total_size: 5 });
  await w.hub.pollAll();
  assert.equal(w.fake.sceneEvents.length, 2);
  assert.deepEqual(logs.texts(), []);
});

test('a client that stays down is logged once, and once when it is back', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t);
  logs.clear();
  w.qb.online = false;
  for (let i = 0; i < 6; i += 1) {
    w.clock.advance(60_000);
    await w.hub.pollAll();
  }
  assert.equal(logs.lines.length, 1, logs.texts().join('\n'));
  assert.equal(logs.lines[0].stream, 'err');

  logs.clear();
  w.qb.online = true;
  await w.hub.pollAll();
  await w.hub.pollAll();
  assert.equal(logs.lines.length, 1, logs.texts().join('\n'));
  assert.match(logs.lines[0].text, /answers again after 5 min/);
});

test('a refused password is logged once; no secret in any line', async (t) => {
  const logs = captureLogs(t);
  const config = {
    ...THREE_CLIENTS,
    client_1_password: 'wrong-password-1',
    client_2_password: 'wrong-password-2',
    client_3_password: 'wrong-password-3',
  };
  const w = await world(t, { config });
  // Three more attempts (qBittorrent bans the address at the fifth).
  for (let i = 0; i < 3; i += 1) {
    w.clock.advance(6 * 60 * 60_000); // past every login back-off
    await w.hub.pollAll();
  }
  await w.fake.action('test_connection', {});
  const warnings = logs.lines.filter((line) => line.stream === 'err');
  assert.equal(warnings.length, 3, logs.texts().join('\n'));
  const all = logs.texts().join('\n');
  for (const secret of ['wrong-password', 'secret', 'admin', 'gladys:', 'sid', 'Basic ']) {
    assert.ok(!all.includes(secret), `"${secret}" in the logs`);
  }
});

test('a user command writes one line', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t);
  logs.clear();
  await w.fake.sceneAction('pause_all', {});
  assert.equal(logs.lines.length, 1, logs.texts().join('\n'));
  assert.match(logs.lines[0].text, /every torrent paused/);
});

test('Gladys refusing the states is logged once', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t);
  logs.clear();
  t.mock.method(w.gladys, 'publishStates', async () => {
    throw new Error('HTTP 500');
  });
  for (let i = 1; i <= 4; i += 1) {
    w.qb.update(DEBIAN, { progress: i / 10, state: 'downloading' });
    await w.hub.pollAll();
  }
  assert.equal(logs.lines.length, 1, logs.texts().join('\n'));
  assert.match(logs.lines[0].text, /States of .* refused/);
});

test('LOG_LEVEL=debug shows each reading problem; never the secrets', async (t) => {
  const logs = captureLogs(t, 'debug');
  const w = await world(t, { config: { ...QB_CONFIG, client_1_password: 'secret' } });
  w.qb.online = false;
  await w.hub.pollAll();
  await w.hub.pollAll();
  const text = logs.texts().join('\n');
  assert.match(text, /\[DEBUG\].*again/);
  assert.ok(!text.includes('secret'), 'never the password');
  assert.ok(!text.includes('sid1'), 'never the session cookie');
});
