// -----------------------------------------------------------------------------
// The torrent hub: one record per configured client, read on a timer of the
// container (the interval chosen in the configuration), its states published
// to Gladys when they change, its scene events fired on transitions, and the
// commands of the switch, the widget and the scene actions.
//
// Gladys never polls these devices (should_poll: false): the core scheduler
// does not poll a device created without should_poll
// (GladysAssistant/Gladys#3198, still in 5.2.1), the interval goes up to two
// minutes, and the scene events must fire even for a client whose device
// was not added. onPoll stays as a fallback.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { TYPE_NAMES } from './config.js';
import { ERROR_KINDS, createClient } from './clients/index.js';
import { magnetHash } from './clients/common.js';
import {
  FEATURE_KEYS,
  buildDevice,
  clientName,
  clientOf,
  deviceIds,
  deviceStates,
} from './devices.js';
import { countTorrents, diffTorrents } from './model.js';
import { ACTION_TEXT, CONNECTION_TEXT, ERROR_TEXT, REPORT_TEXT, labelled, pick } from './texts.js';

const logger = createLogger({ name: 'torrent-hub' });

export const WIDGET_KEY = 'torrents';

// Scene trigger keys (manifest `scene_triggers`): permanent once published.
export const TRIGGERS = Object.freeze({
  COMPLETED: 'download_completed',
  ADDED: 'torrent_added',
});

export const HUB_TIMINGS = {
  // A client that stops answering is read again this soon, to tell a blip from an outage.
  retryMs: 15_000,
  // An unchanged value is published again after this long, so Gladys never
  // shows it as "no recent value" (48 h); well under the 12 h asked.
  heartbeatMs: 6 * 60 * 60_000,
};

// At most this many scene events per client and reading: adding a hundred
// torrents at once must not flood the core (300 events per minute).
export const MAX_EVENTS_PER_READING = 20;

const signature = (client, config) =>
  JSON.stringify([
    client.type,
    client.url,
    client.username,
    client.password,
    config.allowSelfSigned,
  ]);

export class TorrentHub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake Gladys)
   * @param {Function} [options.request] HTTP seam (src/clients/http.js)
   * @param {boolean} [options.timers] periodic timers (off in tests)
   * @param {object} [options.timings] HUB_TIMINGS overrides
   * @param {() => number} [options.now]
   */
  constructor({ gladys, request, timers = true, timings, now }) {
    this.gladys = gladys;
    this.request = request;
    this.timersEnabled = timers;
    this.timings = { ...HUB_TIMINGS, ...timings };
    this.now = now ?? (() => Date.now());
    this.config = null;
    /** @type {Map<number, object>} client records, by slot */
    this.records = new Map();
    this.transports = new Map();
    this.connection = null;
    this.pollTimer = null;
    this.stopped = false;
    /** Problems already logged, by key: their repeats go to debug. */
    this.warned = new Set();
  }

  // --- Logs ------------------------------------------------------------------
  // Info keeps the lifecycle only (clients connected, lost, back, user
  // commands). A problem that repeats every cycle is logged once at its own
  // level, then at debug until it clears. LOG_LEVEL=debug shows everything.

  problem(key, message, err, level = 'warn') {
    const args = err === undefined ? [message] : [message, err];
    if (this.warned.has(key)) {
      logger.debug(...args);
      return;
    }
    this.warned.add(key);
    logger[level](...args);
  }

  resolved(key, message) {
    if (this.warned.delete(key) && message) {
      logger.info(message);
    }
  }

  label(record) {
    return `${TYPE_NAMES[record.client.type]} ${record.client.slot} (${clientName(record.client)})`;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(config) {
    await this.reconfigure(config);
  }

  /** Gladys reconnected (it restarted): send everything again. */
  async resync(config) {
    this.gladys.forgetPublishedStates();
    this.transports.clear();
    this.connection = null;
    await this.reconfigure(config);
  }

  async reconfigure(config) {
    const languageChanged = this.config && this.config.language !== config.language;
    this.config = config;
    const wanted = new Map(config.clients.map((client) => [client.slot, client]));
    for (const [slot, record] of this.records) {
      const client = wanted.get(slot);
      if (!client || record.signature !== signature(client, config)) {
        this.dropRecord(record);
        this.records.delete(slot);
      }
    }
    for (const client of config.clients) {
      const record = this.records.get(client.slot);
      if (record) {
        record.client = client; // a new name: same session
        if (languageChanged) {
          // The downloads text is written in the language of the configuration.
          this.gladys.forgetPublishedStates(deviceIds(this.gladys, client).device);
        }
      } else {
        this.records.set(client.slot, this.newRecord(client, config));
      }
    }
    await this.publishDevices();
    await this.pollAll();
    this.schedulePoll();
  }

  newRecord(client, config) {
    const api = createClient(client, {
      insecure: config.allowSelfSigned,
      request: this.request,
      now: this.now,
    });
    return {
      client,
      signature: signature(client, config),
      api,
      reading: null,
      connected: null,
      error: null,
      failures: 0,
      downSince: null,
      known: new Map(),
      baseline: true,
      polling: null,
      retryTimer: null,
    };
  }

  dropRecord(record) {
    record.dropped = true;
    clearTimeout(record.retryTimer);
    this.gladys.forgetPublishedStates(deviceIds(this.gladys, record.client).device);
    record.api.logout().catch(() => {});
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    await Promise.all(
      [...this.records.values()].map(async (record) => {
        clearTimeout(record.retryTimer);
        await record.api.logout().catch(() => {});
      }),
    );
  }

  schedulePoll() {
    clearTimeout(this.pollTimer);
    if (!this.timersEnabled || this.stopped || this.records.size === 0) {
      return;
    }
    this.pollTimer = setTimeout(async () => {
      try {
        await this.pollAll();
        this.resolved('poll');
      } catch (err) {
        this.problem('poll', 'Reading failed', err, 'error');
      }
      this.schedulePoll();
    }, this.config.pollIntervalMs);
  }

  // --- Devices -----------------------------------------------------------------

  async publishDevices() {
    const devices = [...this.records.values()].map((record) =>
      buildDevice(this.gladys, record.client, record.api.supportsAltSpeed, this.config.language),
    );
    // Even an empty list: the Discovery tab then shows no stale client.
    await this.gladys.publishDiscoveredDevices(devices);
  }

  /** "Search" in the Discovery tab: publish the devices again, read the clients. */
  async rediscover() {
    await this.publishDevices();
    await this.pollAll();
  }

  /** The user added a device: its states sent before were dropped by Gladys. */
  async onDeviceCreated(device) {
    const client = clientOf(this.gladys, this.config.clients, device.external_id);
    const record = client ? this.records.get(client.slot) : null;
    if (!record) {
      return;
    }
    // The SDK forgot the values of this device: everything goes again.
    this.gladys.forgetPublishedStates(device.external_id);
    await this.publishStates(record);
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  // --- Reading the clients -------------------------------------------------------

  async pollAll({ force = false } = {}) {
    const records = [...this.records.values()];
    const changes = await Promise.all(records.map((record) => this.poll(record, { force })));
    await this.afterChanges(changes.some(Boolean));
  }

  /** Gladys asks for a refresh (onPoll): read that client now. */
  async pollDevice(device) {
    const client = clientOf(this.gladys, this.config.clients, device.external_id);
    const record = client ? this.records.get(client.slot) : null;
    if (record) {
      await this.afterChanges(await this.poll(record, {}));
    }
  }

  /**
   * Read one client and apply what changed. Concurrent calls share the read.
   * @returns {Promise<boolean>} whether the widget shows something new
   */
  poll(record, { force = false } = {}) {
    record.polling ??= this.read(record, { force }).finally(async () => {
      record.polling = null;
      if (record.dropped) {
        // Removed from the configuration while it was being read: the read
        // may have opened a new session, close it.
        await record.api.logout().catch(() => {});
      }
    });
    return record.polling;
  }

  async read(record, { force }) {
    let reading;
    try {
      reading = await record.api.read({ force });
    } catch (err) {
      if (!err.kind) {
        throw err;
      }
      return this.applyFailure(record, err);
    }
    return this.applySuccess(record, reading);
  }

  async applySuccess(record, reading) {
    if (record.dropped) {
      return false;
    }
    if (record.downSince !== null) {
      const minutes = Math.round((this.now() - record.downSince) / 60_000);
      logger.info(`${this.label(record)} answers again after ${minutes} min`);
    } else if (record.error) {
      logger.info(`${this.label(record)}: connection restored`);
    } else if (record.connected === null) {
      const version = reading.version ? ` ${reading.version}` : '';
      logger.info(
        `${this.label(record)}: connected to ${TYPE_NAMES[record.client.type]}${version}, ${reading.torrents.length} torrent(s)`,
      );
    }
    const previous = record.reading;
    const widgetChanged =
      record.connected !== true || record.error !== null || changedForWidget(previous, reading);
    record.connected = true;
    record.error = null;
    record.failures = 0;
    record.downSince = null;
    record.reading = reading;

    const { added, completed } = diffTorrents(record.known, reading.torrents, record.baseline);
    record.baseline = false;
    await this.fireEvents(record, TRIGGERS.ADDED, added);
    await this.fireEvents(record, TRIGGERS.COMPLETED, completed);

    await this.publishStates(record);
    return widgetChanged || added.length > 0 || completed.length > 0;
  }

  async applyFailure(record, err) {
    if (record.dropped) {
      return false;
    }
    const wasError = record.error?.kind;
    record.error = { kind: err.kind, message: err.message };
    // One warning when the problem starts (or changes), not one per reading.
    if (wasError !== err.kind) {
      logger.warn(`${this.label(record)}: ${err.message}`);
    } else {
      logger.debug(`${this.label(record)}: ${err.message} (again)`);
    }
    const wasConnected = record.connected;
    record.connected = false;
    if (err.kind === ERROR_KINDS.UNREACHABLE) {
      record.failures += 1;
      if (record.failures === 1) {
        record.downSince = this.now();
        this.scheduleRetry(record);
      }
    } else {
      // A refused password is a configuration problem, not an outage.
      record.failures = 0;
      record.downSince = null;
    }
    await this.publishStates(record);
    return wasError !== err.kind || wasConnected !== false;
  }

  scheduleRetry(record) {
    clearTimeout(record.retryTimer);
    if (!this.timersEnabled || this.stopped) {
      return;
    }
    record.retryTimer = setTimeout(() => {
      this.poll(record)
        .then((changed) => this.afterChanges(changed))
        .then(() => this.resolved('retry'))
        .catch((err) => this.problem('retry', 'Retry failed', err, 'error'));
    }, this.timings.retryMs);
    record.retryTimer.unref?.();
  }

  /** One scene event per torrent, at most MAX_EVENTS_PER_READING per reading. */
  async fireEvents(record, key, torrents) {
    const kept = torrents.slice(0, MAX_EVENTS_PER_READING);
    if (torrents.length > kept.length) {
      logger.debug(
        `${this.label(record)}: ${torrents.length - kept.length} ${key} event(s) not sent (too many at once)`,
      );
    }
    for (const torrent of kept) {
      logger.debug(`${this.label(record)}: ${key} "${torrent.name}"`);
      try {
        await this.gladys.publishSceneEvent(key, {
          device: deviceIds(this.gladys, record.client).device,
          client: clientName(record.client),
          name: torrent.name.slice(0, 1000),
          category: torrent.category ?? '',
          size_gb: torrent.size === null ? 0 : Math.round(torrent.size / 1e7) / 100,
        });
        this.resolved('scene-event');
      } catch (err) {
        this.problem('scene-event', `Scene event ${key} refused: ${err.message}`);
      }
    }
  }

  // --- Publishing to Gladys ----------------------------------------------------------

  async publishStates(record) {
    const states = deviceStates(this.gladys, record.client, {
      reading: record.reading,
      connected: record.connected,
      supportsAltSpeed: record.api.supportsAltSpeed,
      language: this.config.language,
    });
    try {
      await this.gladys.publishChangedStates(states, { heartbeat: this.timings.heartbeatMs });
      this.resolved('states');
    } catch (err) {
      this.problem('states', `States of ${this.label(record)} refused: ${err.message}`);
    }
  }

  async afterChanges(widgetChanged) {
    await this.publishTransports();
    await this.publishConnectionStatus();
    if (widgetChanged) {
      this.gladys.requestWidgetRefresh(WIDGET_KEY);
    }
  }

  async publishTransports() {
    const entries = [];
    for (const record of this.records.values()) {
      if (record.connected === null) {
        continue;
      }
      const externalId = deviceIds(this.gladys, record.client).device;
      const transport = record.connected ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE;
      if (this.transports.get(externalId) !== transport) {
        entries.push({ external_id: externalId, transport });
      }
    }
    if (entries.length === 0) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      for (const entry of entries) {
        this.transports.set(entry.external_id, entry.transport);
      }
      this.resolved('transports');
    } catch (err) {
      this.problem('transports', `Transports refused: ${err.message}`);
    }
  }

  /** The status under the integration name: connected while one client answers. */
  connectionStatus() {
    const { clients, invalidSlots } = this.config;
    if (clients.length === 0) {
      return {
        connected: false,
        message: invalidSlots.length ? CONNECTION_TEXT.invalidUrl : CONNECTION_TEXT.noClient,
      };
    }
    const failing = [...this.records.values()].filter((record) => record.error);
    if (failing.length === 0 && invalidSlots.length === 0) {
      return { connected: true };
    }
    const message = {};
    for (const language of Object.keys(CONNECTION_TEXT.noClient)) {
      const parts = failing.map((record) =>
        labelled(
          clientName(record.client),
          pick(ERROR_TEXT[record.error.kind], language),
          language,
        ),
      );
      if (invalidSlots.length) {
        parts.push(pick(CONNECTION_TEXT.invalidUrl, language));
      }
      message[language] = parts.join(' · ').slice(0, 200);
    }
    return { connected: failing.length < this.records.size, message };
  }

  async publishConnectionStatus() {
    const status = this.connectionStatus();
    const key = JSON.stringify(status);
    if (key === this.connection) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.connection = key;
      this.resolved('connection-status');
    } catch (err) {
      this.problem('connection-status', `Connection status refused: ${err.message}`);
    }
  }

  // --- Commands --------------------------------------------------------------------------

  /**
   * The clients a command targets: one device, or every configured client.
   * @param {string|null|undefined} deviceExternalId
   */
  targets(deviceExternalId) {
    if (this.records.size === 0) {
      throw new Error(pick(ACTION_TEXT.noClient, this.config?.language));
    }
    if (!deviceExternalId) {
      return [...this.records.values()];
    }
    const client = clientOf(this.gladys, this.config.clients, deviceExternalId);
    const record = client ? this.records.get(client.slot) : null;
    if (!record) {
      throw new Error(pick(ACTION_TEXT.unknownClient, this.config.language));
    }
    return [record];
  }

  /** The error message of a failed command on one client, in the configured language. */
  commandError(record, err) {
    const language = this.config.language;
    return labelled(
      clientName(record.client),
      pick(ERROR_TEXT[err.kind] ?? ERROR_TEXT[ERROR_KINDS.HTTP], language),
      language,
    );
  }

  /**
   * Run a command on the targeted clients, then read them again.
   * @returns {Promise<number>} the number of clients that accepted
   */
  async command(records, what, run) {
    const errors = [];
    const results = await Promise.all(
      records.map(async (record) => {
        try {
          await run(record);
          logger.info(`${this.label(record)}: ${what}`);
          return true;
        } catch (err) {
          if (!err.kind) {
            throw err;
          }
          logger.warn(`${this.label(record)}: ${what} failed: ${err.message}`);
          errors.push(this.commandError(record, err));
          return false;
        }
      }),
    );
    // The new state, without waiting for the next reading (after the one in
    // progress, if any: it may have started before the command).
    await Promise.all(
      records.map(async (record) => {
        await record.polling?.catch(() => {});
        await this.poll(record);
      }),
    );
    await this.afterChanges(true);
    const done = results.filter(Boolean).length;
    if (done === 0) {
      throw new Error(
        records.length === 1 && errors.length === 1
          ? errors[0]
          : pick(ACTION_TEXT.failed, this.config.language),
      );
    }
    return done;
  }

  pauseAll(deviceExternalId) {
    return this.command(this.targets(deviceExternalId), 'every torrent paused', (record) =>
      record.api.pauseAll(),
    );
  }

  resumeAll(deviceExternalId) {
    return this.command(this.targets(deviceExternalId), 'every torrent resumed', (record) =>
      record.api.resumeAll(),
    );
  }

  /** Alternative speed limits on or off, on the clients that have them. */
  setAltSpeed(deviceExternalId, enabled) {
    const records = this.targets(deviceExternalId).filter((record) => record.api.supportsAltSpeed);
    if (records.length === 0) {
      throw new Error(pick(ACTION_TEXT.noAltSpeed, this.config.language));
    }
    return this.command(
      records,
      `alternative speed limits ${enabled ? 'on' : 'off'}`,
      async (record) => {
        await record.api.setAltSpeed(enabled);
      },
    );
  }

  /**
   * Add a magnet link to one client (the chosen one, else the first
   * configured). Only when the configuration allows it.
   * @returns {Promise<string>} the info hash
   */
  async addMagnet(deviceExternalId, uri) {
    const language = this.config?.language;
    if (!this.config?.allowMagnet) {
      throw new Error(pick(ACTION_TEXT.magnetDisabled, language));
    }
    const magnet = typeof uri === 'string' ? uri.trim() : '';
    if (!magnetHash(magnet)) {
      throw new Error(pick(ACTION_TEXT.notMagnet, language));
    }
    const [record] = this.targets(deviceExternalId);
    let hash = null;
    await this.command([record], 'magnet link added', async (target) => {
      ({ hash } = await target.api.addMagnet(magnet));
    });
    return hash;
  }

  /** The alternative speed switch of a device. */
  async setValue(device, feature, value) {
    const client = clientOf(this.gladys, this.config.clients, device.external_id);
    if (
      !client ||
      feature.external_id !== deviceIds(this.gladys, client).feature(FEATURE_KEYS.ALT_SPEED)
    ) {
      throw new Error(`Feature ${feature.external_id} cannot be controlled`);
    }
    await this.setAltSpeed(device.external_id, Number(value) === 1);
  }

  // --- Reports -------------------------------------------------------------------------------

  /** "Test the connection": read every client now (no login back-off), one line each. */
  async testConnection() {
    await this.pollAll({ force: true });
    const message = {};
    for (const [language, text] of Object.entries(REPORT_TEXT)) {
      if (this.records.size === 0) {
        message[language] = pick(this.connectionStatus().message, language);
        continue;
      }
      const lines = [...this.records.values()].map((record) => {
        const name = clientName(record.client);
        if (record.error) {
          return labelled(name, pick(ERROR_TEXT[record.error.kind], language), language);
        }
        const { version, torrents, altSpeed } = record.reading;
        const counts = countTorrents(torrents);
        const parts = [text.ok];
        parts.push(`${TYPE_NAMES[record.client.type]}${version ? ` ${version}` : ''}`);
        parts.push(text.torrents(counts.downloading, counts.total));
        if (altSpeed) {
          parts.push(text.altSpeed);
        }
        return labelled(name, parts.join(', '), language);
      });
      if (this.config.invalidSlots.length) {
        lines.push(pick(CONNECTION_TEXT.invalidUrl, language));
      }
      message[language] = lines.join('\n');
    }
    return message;
  }

  /** What the widget shows, for one client or all of them. */
  view(deviceExternalId) {
    if (!deviceExternalId) {
      return [...this.records.values()];
    }
    const client = clientOf(this.gladys, this.config.clients, deviceExternalId);
    const record = client ? this.records.get(client.slot) : null;
    return record ? [record] : [];
  }
}

/**
 * Whether the widget needs a refresh: the counters, the alternative speed,
 * the downloads listed. Not the speeds or the percentages: they move at
 * every reading, and the widget's own refresh (30 s) follows them.
 */
function changedForWidget(previous, next) {
  if (!previous) {
    return true;
  }
  const a = countTorrents(previous.torrents);
  const b = countTorrents(next.torrents);
  return (
    a.downloading !== b.downloading ||
    a.paused !== b.paused ||
    a.completed !== b.completed ||
    previous.altSpeed !== next.altSpeed
  );
}
