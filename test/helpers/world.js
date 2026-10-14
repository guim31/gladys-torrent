// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys, fake torrent clients on a
// fake network and a manual clock, with the integration wired on top through
// registerHandlers. No timer runs unless `timers: true` (with node:test mock
// timers): the tests read the clients with `world.hub.pollAll()`.
// (Adapted from guim31/gladys-pihole.)
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { FakeDeluge, FakeQbittorrent, FakeTransmission, createNetwork } from './fakeClients.js';

// The integration logs every change; keep the test output readable.
process.env.LOG_LEVEL ??= 'silent';

export const QB_URL = 'http://192.0.2.10:8080';
export const TR_URL = 'http://192.0.2.11:9091';
export const DE_URL = 'https://198.51.100.12:8112';

export const QB_CONFIG = {
  client_1_type: 'qbittorrent',
  client_1_url: '192.0.2.10',
  client_1_username: 'admin',
  client_1_password: 'secret',
  client_1_name: 'NAS',
  language: 'en',
};

export const THREE_CLIENTS = {
  ...QB_CONFIG,
  client_2_type: 'transmission',
  client_2_url: '192.0.2.11:9091',
  client_2_username: 'gladys',
  client_2_password: 'secret',
  client_3_type: 'deluge',
  client_3_url: DE_URL,
  client_3_password: 'deluge',
  allow_self_signed: true,
};

/** A manual clock. */
export function createClock(start = Date.UTC(2026, 9, 14, 10, 0, 0)) {
  const clock = {
    time: start,
    now: () => clock.time,
    advance(ms) {
      clock.time += ms;
    },
  };
  return clock;
}

export const defaultServers = () => ({
  [QB_URL]: new FakeQbittorrent(),
  [TR_URL]: new FakeTransmission(),
  [DE_URL]: new FakeDeluge(),
});

/**
 * @param {object} [options]
 * @param {Record<string, object>} [options.servers] by origin
 * @param {object} [options.config] raw integration config
 * @param {Array} [options.devices] devices already created in Gladys
 */
export async function createWorld({
  clock = createClock(),
  servers = defaultServers(),
  config = QB_CONFIG,
  devices = [],
  connect = true,
  timings = {},
  timers = false,
} = {}) {
  const network = createNetwork(servers);
  const gladys = createFakeGladys({ config, devices });
  const app = registerHandlers(gladys, {
    request: network.request,
    timers,
    timings,
    now: clock.now,
  });
  if (connect) {
    await gladys.connect();
    await app.ready;
  }
  return {
    gladys,
    fake: gladys.fake,
    network,
    servers,
    qb: servers[QB_URL],
    tr: servers[TR_URL],
    de: servers[DE_URL],
    app,
    hub: app.hub,
    clock,
  };
}

/** External ids of the device of a client. */
export const ids = (gladys, type = 'qbittorrent', slot = 1) =>
  gladys.externalIds(type, String(slot));

/** Add every discovered device in Gladys, as the user would. */
export async function createAll(world) {
  for (const device of world.fake.discoveredDevices) {
    await world.fake.deviceCreated(device);
  }
}

export { FakeDeluge, FakeQbittorrent, FakeTransmission };
