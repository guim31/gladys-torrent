// Normalization of the configuration and of the addresses typed by the user.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig, parseClientUrl } from '../src/config.js';

test('an address without scheme nor port gets the default port of the software', () => {
  assert.equal(parseClientUrl('192.0.2.10', 'qbittorrent'), 'http://192.0.2.10:8080');
  assert.equal(parseClientUrl('192.0.2.10', 'transmission'), 'http://192.0.2.10:9091');
  assert.equal(parseClientUrl(' nas.local ', 'deluge'), 'http://nas.local:8112');
  assert.equal(parseClientUrl('192.0.2.10:8090', 'qbittorrent'), 'http://192.0.2.10:8090');
});

test('an address with a scheme keeps its port, and its path for a reverse proxy', () => {
  assert.equal(parseClientUrl('https://192.0.2.10', 'qbittorrent'), 'https://192.0.2.10');
  assert.equal(
    parseClientUrl('http://nas.local/qbittorrent/', 'qbittorrent'),
    'http://nas.local/qbittorrent',
  );
  assert.equal(
    parseClientUrl('http://192.0.2.11:9091/transmission/web/', 'transmission'),
    'http://192.0.2.11:9091/transmission/web',
  );
});

test('unusable addresses are refused, credentials included', () => {
  for (const raw of [
    '',
    '   ',
    'ftp://192.0.2.10',
    'http://',
    'http://user:pass@192.0.2.10',
    12,
    null,
  ]) {
    assert.equal(parseClientUrl(raw, 'qbittorrent'), null, String(raw));
  }
});

test('the defaults: no client, 30 s, French, magnet links off', () => {
  const config = normalizeConfig({});
  assert.deepEqual(config.clients, []);
  assert.equal(config.pollIntervalMs, 30_000);
  assert.equal(config.language, 'fr');
  assert.equal(config.allowMagnet, false);
  assert.equal(config.allowSelfSigned, false);
  assert.equal(DEFAULT_CONFIG.language, 'fr');
});

test('three clients, an invalid one reported by slot', () => {
  const config = normalizeConfig({
    client_1_type: 'qbittorrent',
    client_1_url: '192.0.2.10',
    client_1_username: ' admin ',
    client_1_password: ' pass with spaces ',
    client_2_type: 'nonsense',
    client_2_url: '192.0.2.11',
    client_3_type: 'deluge',
    client_3_url: 'http://user:pw@192.0.2.12',
    poll_interval: 120,
    allow_magnet: 'true',
    language: 'xx',
  });
  assert.deepEqual(
    config.clients.map(({ slot, type, url }) => [slot, type, url]),
    [
      [1, 'qbittorrent', 'http://192.0.2.10:8080'],
      // An unknown software falls back to the slot default.
      [2, 'transmission', 'http://192.0.2.11:9091'],
    ],
  );
  assert.equal(config.clients[0].username, 'admin');
  assert.equal(config.clients[0].password, ' pass with spaces ');
  assert.equal(config.clients[0].name, null);
  assert.deepEqual(config.invalidSlots, [3]);
  assert.equal(config.pollIntervalMs, 120_000);
  assert.equal(config.allowMagnet, true);
  assert.equal(config.language, 'fr');
});
