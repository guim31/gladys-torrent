// The meaning of a reading: counters, the downloads text, the scene events.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countTorrents,
  diffTorrents,
  downloadsText,
  formatSpeed,
  toGigabytes,
  toKilobytesPerSecond,
} from '../src/model.js';

const torrent = (hash, fields = {}) => ({
  hash,
  name: hash,
  progress: 0,
  paused: false,
  checking: false,
  downloading: true,
  error: false,
  hasMetadata: true,
  complete: false,
  downloadSpeed: 0,
  downloaded: 0,
  size: 1e9,
  category: null,
  addedAt: null,
  ...fields,
});
const done = (hash, fields) =>
  torrent(hash, { progress: 1, complete: true, downloading: false, downloaded: 1e9, ...fields });

test('the three counters split the torrents and add up to the total', () => {
  const counts = countTorrents([
    torrent('a'),
    torrent('b', { paused: true, downloading: false }),
    done('c'),
    done('d', { paused: true }), // paused once its ratio was reached: completed
    torrent('e', { downloading: false, checking: true }),
  ]);
  assert.deepEqual(counts, { downloading: 2, paused: 1, completed: 2, total: 5 });
});

test('the downloads text: active first, three at most, the rest counted', () => {
  const list = [
    torrent('Slow', { progress: 0.9 }),
    torrent('Fast', { progress: 0.1, downloadSpeed: 500_000 }),
    torrent('Middle', { progress: 0.42 }),
    torrent('Last', { progress: 0.01 }),
    torrent('Paused', { progress: 0.5, paused: true }),
    done('Done'),
  ];
  assert.equal(downloadsText(list, 'en', 'none'), 'Fast 10% · Slow 90% · Middle 42% · +1');
  assert.equal(
    downloadsText(list, 'fr', 'aucun'),
    'Fast 10\u202f% · Slow 90\u202f% · Middle 42\u202f% · +1',
  );
  assert.equal(downloadsText([done('x')], 'en', 'No download'), 'No download');
});

test('a percentage never reads 100 before the end; long names are cut', () => {
  const name = 'A'.repeat(60);
  const text = downloadsText([torrent(name, { progress: 0.999 })], 'en', '-');
  assert.equal(text, `${'A'.repeat(39)}… 99%`);
});

test('units: kB/s rounded, GB with one decimal, widget speeds scaled', () => {
  assert.equal(toKilobytesPerSecond(1_563_128), 1563);
  assert.equal(toGigabytes(31_805_792_256), 31.8);
  assert.deepEqual(formatSpeed(42_583, 'en'), { value: 43, unit: 'kB/s' });
  assert.deepEqual(formatSpeed(2_181_474, 'fr'), { value: 2.2, unit: 'Mo/s' });
  assert.deepEqual(formatSpeed(1.25e9, 'de'), { value: 1.3, unit: 'GB/s' });
});

test('the first reading announces nothing', () => {
  const known = new Map();
  const events = diffTorrents(known, [torrent('a'), done('b')], true);
  assert.deepEqual(events, { added: [], completed: [] });
  assert.equal(known.size, 2);
});

test('a torrent seen downloading, then complete, is announced once', () => {
  const known = new Map();
  diffTorrents(known, [torrent('a', { progress: 0.5 })], true);
  assert.deepEqual(
    diffTorrents(known, [done('a')], false).completed.map((t) => t.hash),
    ['a'],
  );
  assert.deepEqual(diffTorrents(known, [done('a')], false).completed, []);
});

test('a torrent added with its data on disk (check, then complete) is not a download', () => {
  const known = new Map();
  diffTorrents(known, [], true);
  const checking = torrent('a', { downloading: false, checking: true, progress: 0.3 });
  assert.deepEqual(
    diffTorrents(known, [checking], false).added.map((t) => t.hash),
    ['a'],
  );
  assert.deepEqual(diffTorrents(known, [done('a', { downloaded: 0 })], false).completed, []);
});

test('a small torrent added and downloaded between two readings is announced', () => {
  const known = new Map();
  diffTorrents(known, [], true);
  const events = diffTorrents(known, [done('quick', { downloaded: 2e6 })], false);
  assert.deepEqual(
    events.added.map((t) => t.hash),
    ['quick'],
  );
  assert.deepEqual(
    events.completed.map((t) => t.hash),
    ['quick'],
  );
});

test('a complete torrent checked again is not announced again', () => {
  const known = new Map();
  diffTorrents(known, [torrent('a', { progress: 0.9 })], true);
  diffTorrents(known, [done('a')], false);
  const recheck = torrent('a', { downloading: false, checking: true, progress: 0.4 });
  diffTorrents(known, [recheck], false);
  assert.deepEqual(diffTorrents(known, [done('a')], false).completed, []);
});

test('a magnet link is announced once its metadata is known, with its real name', () => {
  const known = new Map();
  diffTorrents(known, [], true);
  const waiting = torrent('h', { name: 'h', hasMetadata: false });
  assert.deepEqual(diffTorrents(known, [waiting], false).added, []);
  const named = torrent('h', { name: 'Big Buck Bunny' });
  assert.deepEqual(
    diffTorrents(known, [named], false).added.map((t) => t.name),
    ['Big Buck Bunny'],
  );
  assert.deepEqual(diffTorrents(known, [named], false).added, []);
});

test('a removed torrent is forgotten', () => {
  const known = new Map();
  diffTorrents(known, [torrent('a')], true);
  diffTorrents(known, [], false);
  assert.equal(known.size, 0);
});
