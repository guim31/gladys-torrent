// -----------------------------------------------------------------------------
// Conformity with the Gladys core, on every device discovered from realistic
// fixtures (answers recorded on qbittorrent-nox 4.6.3, transmission-daemon
// 4.0.5, Deluge 2.1 and rTorrent 0.16.25): one to three clients of every software, before and
// after a reading, in every feature-name language.
//
// The table (test/fixtures/gladys-feature-table.json) is extracted from the
// core code: a category/type couple missing there shows as "undefined" or
// without icon in Gladys, a poll frequency outside its list is a 400 on
// discovery, a feature without min/max is a 422 on "Add to Gladys".
// Do not loosen this test to make it pass: fix the integration.
// (Adapted from guim31/gladys-wled and guim31/gladys-pihole.)
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { QB_CONFIG, THREE_CLIENTS, WITH_RTORRENT, createWorld } from './helpers/world.js';

const table = JSON.parse(
  await readFile(new URL('./fixtures/gladys-feature-table.json', import.meta.url), 'utf8'),
);

const TWO_QBITTORRENT = {
  ...QB_CONFIG,
  client_2_type: 'qbittorrent',
  client_2_url: '192.0.2.10:8080',
  client_2_username: 'admin',
  client_2_password: 'secret',
};

const scenarios = [
  { label: 'one qBittorrent', config: QB_CONFIG, count: 1 },
  { label: 'two instances of the same software', config: TWO_QBITTORRENT, count: 2 },
  { label: 'the three programs', config: THREE_CLIENTS, count: 3 },
  { label: 'French names', config: { ...THREE_CLIENTS, language: 'fr' }, count: 3 },
  { label: 'German names', config: { ...THREE_CLIENTS, language: 'de' }, count: 3 },
  { label: 'Spanish names', config: { ...THREE_CLIENTS, language: 'es' }, count: 3 },
  { label: 'rTorrent', config: WITH_RTORRENT, count: 3 },
  { label: 'rTorrent, French names', config: { ...WITH_RTORRENT, language: 'fr' }, count: 3 },
  { label: 'rTorrent, German names', config: { ...WITH_RTORRENT, language: 'de' }, count: 3 },
  { label: 'rTorrent, Spanish names', config: { ...WITH_RTORRENT, language: 'es' }, count: 3 },
];

for (const scenario of scenarios) {
  test(`every discovered device follows the Gladys rules (${scenario.label})`, async () => {
    const { gladys, app } = await createWorld({ config: scenario.config });
    try {
      const devices = gladys.fake.discoveredDevices;
      assert.equal(devices.length, scenario.count);
      assert.equal(new Set(devices.map((d) => d.external_id)).size, devices.length);
      assert.equal(new Set(devices.map((d) => d.name)).size, devices.length, 'distinct names');

      for (const device of devices) {
        const where = device.name;

        // should_poll: true if and only if poll_frequency is provided, in ms.
        if (device.poll_frequency === undefined) {
          assert.notEqual(device.should_poll, true, `${where}: should_poll without poll_frequency`);
        } else {
          assert.equal(device.should_poll, true, `${where}: poll_frequency without should_poll`);
          assert.ok(
            table.poll_frequencies_ms.includes(device.poll_frequency),
            `${where}: poll_frequency ${device.poll_frequency} is not one of ${table.poll_frequencies_ms}`,
          );
        }

        assert.ok(device.features.length > 0, `${where}: no feature`);
        const externalIds = new Set();
        const names = new Set();
        for (const feature of device.features) {
          const at = `${where} / ${feature.name}`;
          const pair = table.pairs[`${feature.category}/${feature.type}`];
          assert.ok(
            pair,
            `${at}: ${feature.category}/${feature.type} is not a couple Gladys knows`,
          );
          assert.ok(
            pair.label_en && pair.label_fr && pair.icon,
            `${at}: couple without label or icon`,
          );

          assert.equal(typeof feature.min, 'number', `${at}: min must be a number`);
          assert.equal(typeof feature.max, 'number', `${at}: max must be a number`);
          assert.ok(
            Number.isFinite(feature.min) && Number.isFinite(feature.max),
            `${at}: finite min/max`,
          );
          assert.ok(feature.min <= feature.max, `${at}: min > max`);
          assert.equal(typeof feature.read_only, 'boolean', `${at}: read_only must be a boolean`);
          assert.equal(
            typeof feature.has_feedback,
            'boolean',
            `${at}: has_feedback must be a boolean`,
          );
          if (feature.unit !== undefined) {
            assert.ok(table.units.includes(feature.unit), `${at}: unknown unit ${feature.unit}`);
            const allowed = table.units_by_category[feature.category];
            if (allowed) {
              assert.ok(
                allowed.includes(feature.unit),
                `${at}: ${feature.unit} for ${feature.category}`,
              );
            }
          }

          assert.ok(!externalIds.has(feature.external_id), `${at}: duplicate external_id`);
          externalIds.add(feature.external_id);
          assert.ok(!names.has(feature.name), `${at}: duplicate feature name on the device`);
          names.add(feature.name);

          // The value read from the fixtures fits the declared bounds.
          const last = gladys.fake.states.findLast(
            (state) => state.device_feature_external_id === feature.external_id,
          );
          assert.ok(last, `${at}: no state published`);
          if (feature.category === 'text') {
            assert.equal(typeof last.text, 'string', `${at}: a text state`);
            assert.ok(last.text.length > 0 && last.text.length <= 255, `${at}: text length`);
            continue;
          }
          const value = last.state;
          assert.equal(typeof value, 'number', `${at}: no numeric state`);
          assert.ok(value >= feature.min && value <= feature.max, `${at}: ${value} out of bounds`);
          if (['integer', 'binary'].includes(feature.type)) {
            assert.ok(Number.isInteger(value), `${at}: ${value} is not an integer`);
          }
        }
      }
    } finally {
      await app.stop();
    }
  });
}
