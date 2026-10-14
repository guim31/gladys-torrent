// -----------------------------------------------------------------------------
// The reading timer of the container. Gladys never polls a device published
// with should_poll: false (and never polls the devices created without
// should_poll, GladysAssistant/Gladys#3198): the clients must be read by the
// hub's own timer, with no onPoll at all.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QB_CONFIG, createAll, createWorld, ids } from './helpers/world.js';

/** Let the timer callback and the fake network settle. */
const settle = async () => {
  for (let i = 0; i < 30; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const DEBIAN = 'f0f72a7a266aba79d6c5e031c93813ce733c6996';

test('the internal timer reads the clients without any onPoll from Gladys', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = await createWorld({ config: { ...QB_CONFIG, poll_interval: '15' }, timers: true });
  t.after(() => w.app.stop());
  const polled = t.mock.method(w.hub, 'pollDevice');
  await createAll(w);

  assert.equal(w.fake.discoveredDevices[0].should_poll, false, 'Gladys is not asked to poll');
  const reads = () => w.qb.requests.filter((r) => r.path === 'sync/maindata').length;
  const before = reads();

  for (const progress of [0.25, 0.5, 0.75]) {
    w.qb.update(DEBIAN, { progress, state: 'downloading' });
    t.mock.timers.tick(15_000);
    await settle();
    const text = w.fake.states.findLast((s) =>
      s.device_feature_external_id.endsWith(':current_downloads'),
    ).text;
    assert.match(text, new RegExp(`Debian-Netinst.iso ${progress * 100}%`));
  }
  assert.equal(reads() - before, 3, 'one reading per interval');
  assert.equal(polled.mock.callCount(), 0, 'no onPoll involved');
});

test('onPoll still reads the client, as a fallback', async (t) => {
  const w = await createWorld();
  t.after(() => w.app.stop());
  await createAll(w);
  w.qb.update(DEBIAN, { progress: 1, state: 'uploading' });
  const device = w.fake.devices[0];
  assert.deepEqual(await w.fake.poll(device), { success: true });
  assert.equal(w.fake.lastState(ids(w.gladys).feature('torrents_completed')), 1);
});

test('an unreachable client is read again 15 s later, before the next interval', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = await createWorld({ config: { ...QB_CONFIG, poll_interval: '120' }, timers: true });
  t.after(() => w.app.stop());
  w.qb.online = false;
  await w.hub.pollAll();
  w.qb.online = true;
  t.mock.timers.tick(15_000);
  await settle();
  assert.equal(w.fake.lastState(ids(w.gladys).feature('connected')), 1);
});

test('the timer stops with the integration', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = await createWorld({ timers: true });
  await w.app.stop();
  const before = w.qb.requests.length;
  t.mock.timers.tick(10 * 60_000);
  await settle();
  assert.deepEqual(
    w.qb.requests.slice(before).map((r) => r.path),
    [],
  );
});
