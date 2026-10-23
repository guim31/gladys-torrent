# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Changed

- Documentation: Deluge 2.2 is supported (tested on 2.2.0), and the integration
  reaches Deluge through its web interface only, not through the daemon port
  (58846).

## [1.0.1] - 2026-10-14

### Added

- Follow and control up to three torrent clients over the local network:
  qBittorrent (4.1 and later, 5.x included), Transmission (2.80 and later) and
  Deluge (through its web interface), in any mix.
- One device per client: download and upload speeds, torrents in progress,
  paused and completed, the current downloads with their percentage, the free
  space of the download folder, the alternative speed limits as a switch
  (qBittorrent and Transmission), and whether the client is connected.
- The "Torrents" dashboard widget: speeds, downloads in progress, and the
  _Pause all_, _Resume all_ and _Alternative speed_ buttons.
- Scene triggers _Download completed_ and _New torrent added_, with the torrent
  name, the client, the category or label and the size; filters on the client
  and the category.
- Scene actions _Pause all torrents_, _Resume all torrents_, _Alternative speed
  limits_ (on or off), and _Add a magnet link_ (off unless allowed in the
  configuration).
- A _Test the connection_ button, a connection status that names the client and
  the problem, and a local/unreachable badge per device.
- Every text in English, French, German and Spanish, with the documentation in
  the four languages.
- The integration never deletes a torrent or a file.

[Unreleased]: https://github.com/guim31/gladys-torrent/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/guim31/gladys-torrent/releases/tag/v1.0.1
