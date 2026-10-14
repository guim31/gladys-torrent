// -----------------------------------------------------------------------------
// What a reading means, whatever the software. A client (src/clients/) answers
//   { version, downloadSpeed, uploadSpeed (bytes/s), freeSpace (bytes|null),
//     altSpeed (boolean|null when the software has none), torrents: [...] }
// and every torrent has the same shape:
//   { hash, name, progress (0-1), paused, checking, downloading, error,
//     hasMetadata, complete, downloadSpeed, downloaded (bytes, ever), size,
//     category, addedAt }.
//
// The three counters split the torrents without overlap, so they add up to
// the total:
//   - in progress: not complete and not paused (downloading, queued, stalled,
//     checking, waiting for metadata, in error);
//   - paused: not complete and paused by the user (or by a scene);
//   - completed: everything downloaded, seeding or not, paused or not — a
//     client that pauses a torrent once its ratio is reached still counts it
//     as completed.
// -----------------------------------------------------------------------------

export const MAX_LISTED_DOWNLOADS = 3;
export const MAX_NAME_LENGTH = 40;

/** Cut a text to `max` characters, with an ellipsis. */
export const fit = (text, max) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

export const inProgress = (torrent) => !torrent.complete && !torrent.paused;

/** Counters of a reading. */
export function countTorrents(torrents) {
  let downloading = 0;
  let paused = 0;
  let completed = 0;
  for (const torrent of torrents) {
    if (torrent.complete) {
      completed += 1;
    } else if (torrent.paused) {
      paused += 1;
    } else {
      downloading += 1;
    }
  }
  return { downloading, paused, completed, total: torrents.length };
}

/**
 * The downloads in progress, most useful first: the ones receiving data
 * (fastest first), then the most advanced. Stable order for equal ones.
 */
export function downloadsInProgress(torrents) {
  return torrents
    .filter(inProgress)
    .sort(
      (a, b) =>
        Number(b.downloadSpeed > 0) - Number(a.downloadSpeed > 0) ||
        b.progress - a.progress ||
        a.name.localeCompare(b.name) ||
        a.hash.localeCompare(b.hash),
    );
}

/**
 * Whole percent shown for a download: rounded down, so 99.6 % never reads
 * 100 % before the end.
 */
export const percentOf = (torrent) => Math.floor(torrent.progress * 100);

/** "42 %" in French (a narrow no-break space before the sign), "42%" elsewhere. */
export const formatPercent = (value, language) =>
  language === 'fr' ? `${value}\u202f%` : `${value}%`;

/**
 * The text feature: the first three downloads in progress with their
 * percentage, "+N" for the others.
 * @param {Array} torrents
 * @param {string} language
 * @param {string} none text when nothing downloads (never empty: Gladys drops an empty text)
 */
export function downloadsText(torrents, language, none) {
  const list = downloadsInProgress(torrents);
  if (list.length === 0) {
    return none;
  }
  const parts = list
    .slice(0, MAX_LISTED_DOWNLOADS)
    .map(
      (torrent) =>
        `${fit(torrent.name, MAX_NAME_LENGTH)} ${formatPercent(percentOf(torrent), language)}`,
    );
  if (list.length > MAX_LISTED_DOWNLOADS) {
    parts.push(`+${list.length - MAX_LISTED_DOWNLOADS}`);
  }
  return parts.join(' · ');
}

// Speeds published in kilobytes per second (1 kB = 1000 bytes, the unit
// Gladys names "kilobytes-per-second"), rounded: the decimals change at
// every reading and say nothing.
export const toKilobytesPerSecond = (bytesPerSecond) => Math.round(bytesPerSecond / 1000);

// Free space published in gigabytes (10^9 bytes), one decimal.
export const toGigabytes = (bytes) => Math.round(bytes / 1e8) / 10;

/**
 * Speed for a widget tile or row: value and unit, in kB/s below 1 MB/s.
 * @returns {{ value: number, unit: string }}
 */
export function formatSpeed(bytesPerSecond, language) {
  const units =
    language === 'fr' ? { k: 'ko/s', m: 'Mo/s', g: 'Go/s' } : { k: 'kB/s', m: 'MB/s', g: 'GB/s' };
  if (bytesPerSecond >= 1e9) {
    return { value: Math.round(bytesPerSecond / 1e8) / 10, unit: units.g };
  }
  if (bytesPerSecond >= 1e6) {
    return { value: Math.round(bytesPerSecond / 1e5) / 10, unit: units.m };
  }
  return { value: Math.round(bytesPerSecond / 1000), unit: units.k };
}

/** A number written the way the language writes it (decimal comma in fr, de, es). */
export const formatNumber = (value, language) =>
  language === 'en' ? String(value) : String(value).replace('.', ',');

/**
 * The scene events of a new reading, compared with the torrents seen before.
 *
 *   - added: a torrent not seen before, announced once its metadata is known
 *     (a magnet link only has its real name then), never at the first
 *     reading of a client;
 *   - completed: a torrent seen downloading, now complete. "Seen
 *     downloading" keeps a torrent added with its data already on disk (a
 *     check, then complete) from being announced as a finished download.
 *
 * @param {Map<string, object>} known what was seen before, by hash (updated in place)
 * @param {Array} torrents the new reading
 * @param {boolean} baseline first reading: remember, announce nothing
 * @returns {{ added: Array, completed: Array }}
 */
export function diffTorrents(known, torrents, baseline) {
  const added = [];
  const completed = [];
  const seen = new Set();
  for (const torrent of torrents) {
    seen.add(torrent.hash);
    let entry = known.get(torrent.hash);
    if (!entry) {
      // A small torrent can be added and downloaded between two readings: new,
      // already complete, with bytes downloaded (not a check of data on disk).
      const quick = !baseline && torrent.complete && torrent.downloaded > 0;
      entry = {
        announced: baseline,
        sawDownloading: quick,
        complete: quick ? false : torrent.complete,
      };
      known.set(torrent.hash, entry);
    }
    if (!entry.announced && torrent.hasMetadata) {
      entry.announced = true;
      added.push(torrent);
    }
    if (!torrent.complete && torrent.downloading) {
      entry.sawDownloading = true;
    }
    if (torrent.complete && !entry.complete && entry.sawDownloading) {
      completed.push(torrent);
    }
    if (!torrent.complete && entry.complete) {
      // Checked again, or files added: a new download may follow.
      entry.sawDownloading = false;
    }
    entry.complete = torrent.complete;
  }
  for (const hash of known.keys()) {
    if (!seen.has(hash)) {
      known.delete(hash);
    }
  }
  return { added, completed };
}
