// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `torrents`.
//
// The use case: from the wall tablet, see what downloads and how fast, and
// slow everything down when a film starts (or pause it all). Every client by
// default, or the one chosen in the widget settings.
//
// Budget (8 components, 6 tiles, 1 status, 4 buttons): three tiles (download
// speed, upload speed, torrents in progress), one status list (unreachable
// clients, the downloads in progress with their percentage, the paused and
// completed counts) and up to three direct buttons: Pause all, Resume all,
// Alternative speed (a toggle; absent when only Deluge or rTorrent is shown,
// neither has such a mode). The figures are sent as values, not bound to device features,
// so the widget works before the devices are added and sums several clients.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { ERROR_KINDS } from './clients/common.js';
import { clientName } from './devices.js';
import { WIDGET_KEY } from './hub.js';
import {
  countTorrents,
  downloadsInProgress,
  fit,
  formatNumber,
  formatPercent,
  formatSpeed,
  percentOf,
} from './model.js';
import { pick } from './texts.js';

// Action keys of the buttons: permanent once published (unique, the core
// drops a button whose key is taken).
export const ACTIONS = Object.freeze({
  PAUSE_ALL: 'pause_all',
  RESUME_ALL: 'resume_all',
  ALT_SPEED: 'alt_speed',
});

// Download rows of the status list (10 rows at most, with the error rows
// and the two counters).
export const MAX_DOWNLOAD_ROWS = 5;

const ACTIVE_ICON = 'check-circle';

export const TEXT = {
  pick: {
    en: 'Enter the address of your torrent client in the configuration of the integration.',
    fr: "Saisissez l'adresse de votre client torrent dans la configuration de l'intégration.",
    de: 'Gib die Adresse deines Torrent-Clients in der Konfiguration der Integration ein.',
    es: 'Introduzca la dirección de su cliente torrent en la configuración de la integración.',
  },
  unknown: {
    en: 'This client is no longer in the configuration: choose another one in the widget settings.',
    fr: "Ce client n'est plus dans la configuration : choisissez-en un autre dans les réglages du widget.",
    de: 'Dieser Client ist nicht mehr in der Konfiguration: Wähle einen anderen in den Widget-Einstellungen.',
    es: 'Este cliente ya no está en la configuración: elija otro en la configuración del widget.',
  },
  noAnswer: {
    en: 'No torrent client answers: see the Configuration screen of the integration.',
    fr: "Aucun client torrent ne répond : voir l'écran Configuration de l'intégration.",
    de: 'Kein Torrent-Client antwortet: Sieh dir die Konfiguration der Integration an.',
    es: 'Ningún cliente torrent responde: consulte la pantalla de configuración de la integración.',
  },
  download: { en: 'Download', fr: 'Réception', de: 'Download', es: 'Descarga' },
  upload: { en: 'Upload', fr: 'Envoi', de: 'Upload', es: 'Subida' },
  inProgress: { en: 'In progress', fr: 'En cours', de: 'Laufend', es: 'En curso' },
  paused: {
    en: 'Paused torrents',
    fr: 'Torrents en pause',
    de: 'Pausierte Torrents',
    es: 'Torrents en pausa',
  },
  completed: {
    en: 'Completed torrents',
    fr: 'Torrents terminés',
    de: 'Fertige Torrents',
    es: 'Torrents completados',
  },
  noDownload: {
    en: 'No download in progress',
    fr: 'Aucun téléchargement en cours',
    de: 'Kein laufender Download',
    es: 'Ninguna descarga en curso',
  },
  unreachable: { en: 'Unreachable', fr: 'Injoignable', de: 'Nicht erreichbar', es: 'Inaccesible' },
  error: { en: 'Error', fr: 'Erreur', de: 'Fehler', es: 'Error' },
  waiting: { en: 'Waiting…', fr: 'En attente…', de: 'Warte…', es: 'Esperando…' },
  none: { en: 'None', fr: 'Aucun', de: 'Keiner', es: 'Ninguno' },
  pauseAll: { en: 'Pause all', fr: 'Tout en pause', de: 'Alle pausieren', es: 'Pausar todo' },
  resumeAll: { en: 'Resume all', fr: 'Tout reprendre', de: 'Alle fortsetzen', es: 'Reanudar todo' },
  altSpeed: {
    en: 'Alternative speed',
    fr: 'Vitesse alternative',
    de: 'Alternatives Tempo',
    es: 'Velocidad alternativa',
  },
};

// Toasts after a tap (≤ 200 characters).
export const DONE_TEXT = {
  en: {
    paused: (count) => `Torrents paused on ${count} client(s).`,
    resumed: (count) => `Torrents resumed on ${count} client(s).`,
    altOn: (count) => `Alternative speed limits on, on ${count} client(s).`,
    altOff: (count) => `Alternative speed limits off, on ${count} client(s).`,
  },
  fr: {
    paused: (count) => `Torrents mis en pause sur ${count} client(s).`,
    resumed: (count) => `Torrents repris sur ${count} client(s).`,
    altOn: (count) => `Limites de vitesse alternatives activées sur ${count} client(s).`,
    altOff: (count) => `Limites de vitesse alternatives désactivées sur ${count} client(s).`,
  },
  de: {
    paused: (count) => `Torrents auf ${count} Client(s) pausiert.`,
    resumed: (count) => `Torrents auf ${count} Client(s) fortgesetzt.`,
    altOn: (count) => `Alternative Geschwindigkeitslimits auf ${count} Client(s) an.`,
    altOff: (count) => `Alternative Geschwindigkeitslimits auf ${count} Client(s) aus.`,
  },
  es: {
    paused: (count) => `Torrents en pausa en ${count} cliente(s).`,
    resumed: (count) => `Torrents reanudados en ${count} cliente(s).`,
    altOn: (count) => `Límites de velocidad alternativos activados en ${count} cliente(s).`,
    altOff: (count) => `Límites de velocidad alternativos desactivados en ${count} cliente(s).`,
  },
};

const t = (text, language) => pick(text, language);

function message(text, language) {
  return {
    ttl_seconds: 300,
    components: [{ type: 'text', variant: 'body', text: t(text, language) }],
  };
}

/** A speed tile: the unit follows the value (kB/s, MB/s, GB/s). */
function speedTile(bytesPerSecond, label, icon, language) {
  const { value, unit } = formatSpeed(bytesPerSecond, language);
  return { type: 'value', value, unit, label: t(label, language), icon };
}

/** The status row of a client that does not answer. */
function errorRow(record, language) {
  if (record.error) {
    const unreachable = record.error.kind === ERROR_KINDS.UNREACHABLE;
    return {
      label: fit(clientName(record.client), 40),
      icon: 'alert-triangle',
      value: t(unreachable ? TEXT.unreachable : TEXT.error, language),
      color: WIDGET_COLORS.DANGER,
    };
  }
  return {
    label: fit(clientName(record.client), 40),
    icon: 'clock',
    value: t(TEXT.waiting, language),
    color: WIDGET_COLORS.NEUTRAL,
  };
}

/** The status row of one download: its name, its percentage and speed. */
function downloadRow(torrent, language) {
  const percent = formatPercent(percentOf(torrent), language);
  let value = percent;
  if (torrent.downloadSpeed > 0) {
    const speed = formatSpeed(torrent.downloadSpeed, language);
    value = `${percent} · ${formatNumber(speed.value, language)} ${speed.unit}`;
  }
  return {
    label: fit(torrent.name, 40),
    icon: 'download',
    value,
    color: torrent.downloadSpeed > 0 ? WIDGET_COLORS.PRIMARY : WIDGET_COLORS.NEUTRAL,
  };
}

export function buttons(records, language) {
  const answering = records.filter((record) => record.reading && !record.error);
  const list = [
    {
      type: 'button',
      label: t(TEXT.pauseAll, language),
      icon: 'pause',
      style: 'secondary',
      action: { key: ACTIONS.PAUSE_ALL },
    },
    {
      type: 'button',
      label: t(TEXT.resumeAll, language),
      icon: 'play',
      style: 'secondary',
      action: { key: ACTIONS.RESUME_ALL },
    },
  ];
  const withAltSpeed = answering.filter((record) => record.api.supportsAltSpeed);
  if (withAltSpeed.length > 0) {
    const on = withAltSpeed.every((record) => record.reading.altSpeed === true);
    list.push({
      type: 'button',
      label: t(TEXT.altSpeed, language),
      // On: the check mark says so (never the style: `primary` is invisible
      // in dark mode). A tap switches to the other state.
      icon: on ? ACTIVE_ICON : 'chevrons-down',
      style: 'secondary',
      action: { key: ACTIONS.ALT_SPEED, params: { enabled: !on } },
    });
  }
  return list;
}

async function get(hub, { settings, language = 'en' }) {
  if (hub.records.size === 0) {
    return message(TEXT.pick, language);
  }
  const records = hub.view(settings?.device);
  if (records.length === 0) {
    return message(TEXT.unknown, language);
  }
  const answering = records.filter((record) => record.reading && !record.error);
  const components = [];
  if (answering.length === 0) {
    components.push({ type: 'text', variant: 'body', text: t(TEXT.noAnswer, language) });
  }
  const torrents = answering.flatMap((record) => record.reading.torrents);
  const counts = countTorrents(torrents);
  if (answering.length > 0) {
    const sum = (key) => answering.reduce((total, record) => total + record.reading[key], 0);
    components.push(
      speedTile(sum('downloadSpeed'), TEXT.download, 'arrow-down', language),
      speedTile(sum('uploadSpeed'), TEXT.upload, 'arrow-up', language),
      {
        type: 'value',
        value: counts.downloading,
        label: t(TEXT.inProgress, language),
        icon: 'download',
        color: counts.downloading > 0 ? WIDGET_COLORS.PRIMARY : WIDGET_COLORS.NEUTRAL,
      },
    );
  }

  const items = records
    .filter((record) => !record.reading || record.error)
    .map((record) => errorRow(record, language));
  if (answering.length > 0) {
    const downloads = downloadsInProgress(torrents);
    const rows = Math.max(0, Math.min(MAX_DOWNLOAD_ROWS, 8 - items.length));
    if (downloads.length === 0) {
      items.push({
        label: t(TEXT.noDownload, language),
        icon: 'check',
        value: t(TEXT.none, language),
        color: WIDGET_COLORS.NEUTRAL,
      });
    }
    items.push(...downloads.slice(0, rows).map((torrent) => downloadRow(torrent, language)));
    items.push(
      {
        label: t(TEXT.paused, language),
        icon: 'pause-circle',
        value: counts.paused,
        color: counts.paused > 0 ? WIDGET_COLORS.WARNING : WIDGET_COLORS.NEUTRAL,
      },
      {
        label: t(TEXT.completed, language),
        icon: 'check-circle',
        value: counts.completed,
        color: WIDGET_COLORS.SUCCESS,
      },
    );
  }
  if (items.length > 0) {
    components.push({ type: 'status', items: items.slice(0, 10) });
  }
  components.push(...buttons(records, language));
  return { ttl_seconds: 30, components };
}

async function action(hub, { actionKey, params = {}, settings }) {
  const device = settings?.device || null;
  const done = (render) =>
    Object.fromEntries(Object.entries(DONE_TEXT).map(([lang, text]) => [lang, render(text)]));

  if (actionKey === ACTIONS.PAUSE_ALL) {
    const count = await hub.pauseAll(device);
    return { message: done((text) => text.paused(count)) };
  }
  if (actionKey === ACTIONS.RESUME_ALL) {
    const count = await hub.resumeAll(device);
    return { message: done((text) => text.resumed(count)) };
  }
  if (actionKey === ACTIONS.ALT_SPEED) {
    const enabled = params.enabled !== false;
    const count = await hub.setAltSpeed(device, enabled);
    return { message: done((text) => (enabled ? text.altOn(count) : text.altOff(count))) };
  }
  throw new Error(`Unknown action ${actionKey}`);
}

export const WIDGETS = {
  [WIDGET_KEY]: { get, action },
};
