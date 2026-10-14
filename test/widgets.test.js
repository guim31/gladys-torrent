// -----------------------------------------------------------------------------
// The `torrents` widget: content within the core's vocabulary and budget
// (validateWidgetContent of the SDK), its buttons and their toasts.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { ACTIONS } from '../src/widgets.js';
import { QB_CONFIG, THREE_CLIENTS, createWorld, ids } from './helpers/world.js';

async function world(t, options) {
  const w = await createWorld(options);
  t.after(() => w.app.stop());
  return w;
}

async function content(w, settings = {}, language = 'en') {
  const ack = await w.fake.widgetGet('torrents', { settings, language });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(validateWidgetContent(ack.data.content), [], 'rendered as sent');
  return ack.data.content;
}

const byType = (c, type) => c.components.filter((component) => component.type === type);

test('speeds, downloads in progress and three buttons, within the budget', async (t) => {
  const w = await world(t, { config: THREE_CLIENTS });
  w.qb.update('f0f72a7a266aba79d6c5e031c93813ce733c6996', {
    progress: 0.42,
    state: 'downloading',
    dlspeed: 1_500_000,
  });
  w.qb.server.dl_info_speed = 1_500_000;
  await w.hub.pollAll();
  for (const language of ['en', 'fr', 'de', 'es']) {
    const c = await content(w, {}, language);
    assert.equal(c.components.length <= 8, true);
    assert.equal(byType(c, 'value').length, 3);
    assert.equal(byType(c, 'status').length, 1);
    assert.equal(byType(c, 'button').length, 3);
  }
  const c = await content(w, {}, 'fr');
  assert.deepEqual(byType(c, 'value')[0], {
    type: 'value',
    value: 1.5,
    unit: 'Mo/s',
    label: 'Réception',
    icon: 'arrow-down',
  });
  const [first] = byType(c, 'status')[0].items;
  assert.deepEqual(first, {
    label: 'Debian-Netinst.iso',
    icon: 'download',
    value: '42\u202f% · 1,5 Mo/s',
    color: 'primary',
  });
});

test('one client chosen in the settings; Deluge alone has no speed button', async (t) => {
  const w = await world(t, { config: THREE_CLIENTS });
  const deluge = await content(w, { device: ids(w.gladys, 'deluge', 3).device });
  assert.deepEqual(
    byType(deluge, 'button').map((b) => b.action.key),
    [ACTIONS.PAUSE_ALL, ACTIONS.RESUME_ALL],
  );
  const gone = await content(w, { device: 'ext:test-integration:qbittorrent:3' });
  assert.match(gone.components[0].text, /no longer in the configuration/);
});

test('the speed button shows the active mode by its icon, never by its style', async (t) => {
  const w = await world(t);
  let button = byType(await content(w), 'button').find((b) => b.action.key === ACTIONS.ALT_SPEED);
  assert.deepEqual(button.action.params, { enabled: true });
  assert.equal(button.style, 'secondary');
  const ack = await w.fake.widgetAction(
    'torrents',
    ACTIONS.ALT_SPEED,
    { enabled: true },
    { settings: {} },
  );
  assert.equal(ack.success, true);
  assert.equal(ack.data.message.fr, 'Limites de vitesse alternatives activées sur 1 client(s).');
  button = byType(await content(w), 'button').find((b) => b.action.key === ACTIONS.ALT_SPEED);
  assert.equal(button.icon, 'check-circle');
  assert.deepEqual(button.action.params, { enabled: false });
});

test('pause and resume from the widget', async (t) => {
  const w = await world(t);
  let ack = await w.fake.widgetAction('torrents', ACTIONS.PAUSE_ALL, {}, { settings: {} });
  assert.equal(ack.data.message.en, 'Torrents paused on 1 client(s).');
  const paused = byType(await content(w), 'status')[0].items.find(
    (i) => i.label === 'Paused torrents',
  );
  assert.equal(paused.value, 3);
  ack = await w.fake.widgetAction('torrents', ACTIONS.RESUME_ALL, {}, { settings: {} });
  assert.equal(ack.data.message.de, 'Torrents auf 1 Client(s) fortgesetzt.');
  ack = await w.fake.widgetAction('torrents', 'nonsense', {}, { settings: {} });
  assert.equal(ack.success, false);
});

test('a client that does not answer, or no client at all', async (t) => {
  const w = await world(t, { config: THREE_CLIENTS });
  w.qb.online = false;
  await w.hub.pollAll();
  const c = await content(w);
  assert.deepEqual(byType(c, 'status')[0].items[0], {
    label: 'NAS',
    icon: 'alert-triangle',
    value: 'Unreachable',
    color: 'danger',
  });
  w.tr.online = false;
  w.de.online = false;
  await w.hub.pollAll();
  const none = await content(w);
  assert.match(byType(none, 'text')[0].text, /No torrent client answers/);

  const empty = await world(t, { config: { language: 'en' } });
  assert.match((await content(empty)).components[0].text, /Enter the address/);
});

test('nothing downloading: said in one row', async (t) => {
  const w = await world(t, { config: { ...QB_CONFIG } });
  await w.fake.sceneAction('pause_all', {});
  const items = byType(await content(w), 'status')[0].items;
  assert.equal(items[0].label, 'No download in progress');
});

test('a new download refreshes the widget, a speed change does not', async (t) => {
  const w = await world(t);
  const before = w.fake.widgetRefreshes.length;
  w.qb.server.dl_info_speed = 12345;
  await w.hub.pollAll();
  assert.equal(w.fake.widgetRefreshes.length, before);
  w.qb.update('f0f72a7a266aba79d6c5e031c93813ce733c6996', { progress: 1, state: 'uploading' });
  await w.hub.pollAll();
  assert.equal(w.fake.widgetRefreshes.length, before + 1);
});
