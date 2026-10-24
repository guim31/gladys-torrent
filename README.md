# qBittorrent / Transmission / Deluge / rTorrent for Gladys Assistant

An external integration for [Gladys Assistant](https://gladysassistant.com) that
follows and controls the self-hosted torrent clients **qBittorrent** (Web API
v2), **Transmission** (RPC), **Deluge** (web JSON-RPC) and **rTorrent**
(XML-RPC over HTTP, as ruTorrent and Flood use it), over the local network. No cloud, no account. One to three clients, any mix: one of each, or
several instances of the same software.

> **Tested on the real programs, not yet in a real home: feedback welcome.**
> The integration was run against qbittorrent-nox 4.6.3 and 5.2.4,
> transmission-daemon 4.0.5 and Deluge 2.1 (downloads between them included),
> then Deluge 2.2 and rTorrent 0.16.25,
> and its tests replay answers recorded from them. It has not yet run in a real
> Gladys installation, next to a NAS, a reverse proxy or a Docker stack. Please
> report what works and what does not in the
> [issues](https://github.com/guim31/gladys-torrent/issues).

## Features

- **One device per client**: download and upload speeds, torrents in
  progress, paused and completed (three counters that add up to the total),
  the **current downloads** as a text (the first three with their
  percentage), the free space of the download folder, the **alternative speed
  limits** as a switch (qBittorrent alternative rate limits, Transmission
  turtle mode; Deluge and rTorrent have none), and whether the client is
  connected.
- **Dashboard widget** "Torrents": the speeds of every client (or one), the
  downloads in progress with percentage and speed, the paused and completed
  counts, and three direct buttons: **Pause all**, **Resume all**,
  **Alternative speed** (a toggle).
- **Scene triggers**: _Download completed_ and _New torrent added_, with the
  torrent name, the client, the category (qBittorrent) or label (Transmission
  4, Deluge, ruTorrent) and the size; filters on the client and the category.
- **Scene actions**: _Pause all torrents_, _Resume all torrents_,
  _Alternative speed limits_ on or off (one client, or all of them: the classic
  "a film starts on the TV, slow the downloads down"), and _Add a magnet link_,
  off unless allowed in the configuration.
- A **Test the connection** button in the Configuration screen, and a
  connection status that names the client and the problem (password refused,
  address banned by qBittorrent, Transmission whitelist, Deluge daemon,
  certificate…).
- A **transport badge** per device: local, or unreachable.
- Every text in English, French, German and Spanish.
- **Never deletes** a torrent or a file: there is no code path for it, and a
  test checks that no deletion request is ever sent.

## Requirements

- Gladys Assistant **5.1.0** or later (widgets, scene triggers and actions).
- qBittorrent 4.1 or later with the Web UI on (`qbittorrent-nox` included),
  Transmission 2.80 or later with remote access on, Deluge with `deluge-web`
  connected to its daemon, or rTorrent 0.9 or later with its XML-RPC
  published over HTTP by a web server (`…/RPC2`, HTTP Basic optional);
  reachable from the Gladys machine. The SCGI socket of rTorrent reached
  directly (without a web server) is not supported.
- On Transmission, the address of Gladys allowed by `rpc-whitelist` (or the
  whitelist off, with a password).

## Installation

1. In Gladys, open **Integrations** → **Install from GitHub** and enter the
   address of this repository: `https://github.com/guim31/gladys-torrent`
   (or install **qBittorrent / Transmission** from the catalog once it is
   listed).
2. In **Configuration**, choose the software of your client, enter its address
   (`192.168.1.10:8080`, `https://nas.example.com/qbittorrent`…; without a port,
   8080, 9091 or 8112, and 80 with `/RPC2` for rTorrent), its user name and password, and a name; up to two more
   clients below. Save, then click **Test the connection**.
3. Open the **Discover** tab and add the devices.

The user guide is in [`docs/en.md`](docs/en.md) (also in
[French](docs/fr.md), [German](docs/de.md) and [Spanish](docs/es.md)); Gladys
links it from the Configuration screen.

## How it works

- **qBittorrent**: `POST /api/v2/auth/login` opens one session, kept in its
  cookie (`SID`, `QBT_SID_<port>` since 5.1: every cookie is kept); a `403`
  logs in again once. No `Referer` nor `Origin` header: behind a reverse
  proxy, qBittorrent's CSRF protection refuses one that does not match the
  host it sees (qbittorrent-api dropped them for that reason). Each reading is one
  `GET /api/v2/sync/maindata?rid=N`: only what changed since the previous
  reading, merged in memory. qBittorrent 5 (Web API 2.11+) stops and starts
  where 4.x paused and resumed: both are handled. No credentials: no login
  until a `403` asks (the "bypass authentication for whitelisted subnets"
  setting).
- **Transmission**: JSON-RPC on `/transmission/rpc` with HTTP basic
  authentication; the CSRF `X-Transmission-Session-Id` is learnt from the first
  `409` and again after a daemon restart. A reading is `session-get`,
  `session-stats`, `torrent-get` (only the fields used) and `free-space`.
- **Deluge**: JSON-RPC of the web interface on `/json`; `auth.login` opens a
  session cookie, the web interface is connected to its first daemon when it
  is not. A reading is one `web.update_ui`.
- **rTorrent**: XML-RPC with a small codec of its own
  (`src/clients/xmlrpc.js`, no XML dependency), HTTP Basic on every request
  when a user name or password is set. A reading is one `system.multicall`:
  `system.client_version`, the global rates, `directory.default` and
  `d.multicall2` on the `main` view with only the fields used (an rTorrent
  older than 0.9.7, without `d.is_meta` and `d.load_date`, is read again
  without them). Pause all is `d.stop` on the started torrents, resume all
  `d.start` on the stopped ones and `d.resume` on those paused in ruTorrent.
  A non-empty `d.message` is an error, except the tracker messages. The free
  space is `d.free_diskspace` of a torrent in the default directory.
- Every client is read on the integration's own timer (10 s to 2 min, 30 s by
  default), not by the Gladys poller: the devices are published with
  `should_poll: false` (GladysAssistant/Gladys#3198), and `onPoll` remains a
  fallback. An unreachable client is read again 15 s later.
- Only the values that changed are sent to Gladys (`publishChangedStates` of
  the SDK), all of them again when a device is added or Gladys reconnects, and
  an unchanged value every 6 hours (heartbeat).
- _Download completed_ fires for a torrent seen downloading and now complete,
  or new and already complete with bytes downloaded (a small torrent between
  two readings); never for a torrent added with its data on disk, nor a
  re-check. _New torrent added_ fires once the torrent has its metadata (a
  magnet link then has its real name). Nothing is announced at start-up, and
  at most 20 events per client and reading.
- A refused password is retried after 5, 15, 60 minutes then every 6 hours:
  qBittorrent bans an address after 5 failed logins. "Test the connection"
  retries at once.
- HTTP(S) runs on `node:http` / `node:https`, so a self-signed certificate can
  be accepted for these clients only, when the option is ticked. Nothing is
  written under `/data`; passwords stay in the Gladys configuration and never
  reach the logs.

## Checked on the real programs, and what was not

Checked in a development session (14/10/2026), with qbittorrent-nox 4.6.3
(Ubuntu package) and 5.2.4 (static build), transmission-daemon 4.0.5 and
Deluge 2.1.2 running locally, Transmission seeding test torrents that
qBittorrent and Deluge downloaded. Deluge 2.2.0 checked again on 23/10/2026
in the `lscr.io/linuxserver/deluge` image (a seeding torrent, a paused one and a
failed one; pause and resume all). rTorrent 0.16.25 checked on 24/10/2026 in
the `crazymax/rtorrent-rutorrent` image, nginx in front, with and without HTTP
Basic (torrents made locally without tracker, on a network without Internet
access for the magnet link):

- reading, counters, current downloads, free space, alternative speed, wrong
  password, wrong address, wrong software, on the three programs;
- pause all, resume all, alternative speed on and off, adding a magnet link
  (and the duplicate refused) on the three programs;
- _New torrent added_ (with its category) and _Download completed_ on a real
  download in qBittorrent; no _Download completed_ for the same torrent added
  to Transmission with its data already on disk;
- qBittorrent 5.2: the `QBT_SID_<port>` cookie, the `204` login, the `401` on
  a wrong password, the `409` on a duplicate, `stop`/`start` and the
  `stoppedDL`/`stoppedUP` states;
- rTorrent: a seeding torrent with a ruTorrent label, one paused (`d.pause`),
  one stopped (`d.stop`), one downloading, one whose file was deleted
  (stopped by rTorrent with a message), a magnet link waiting for its
  metadata; pause all and resume all; no login, a wrong password, the right
  one; `npm run test:real` and the integration in the Gladys sandbox
  constraints.

The answers are recorded in `test/fixtures/` (paths anonymized), and
`npm run test:real` drives the real programs again (see
[`CLAUDE.md`](CLAUDE.md)). Not checked: a real Gladys instance, HTTPS with a
self-signed certificate, reverse proxies, Transmission 3.x and older, Deluge
1.3, rTorrent 0.9.x (the fallback without `d.is_meta` and `d.load_date` is
only tested on a fake), the ruTorrent _rpc_ plugin (`rpc.php`), the Deluge
daemon reached directly (port 58846, rencode protocol: the
integration only speaks to the web interface), libraries of thousands of
torrents, the Docker image under the Gladys sandbox. `scripts/probe.mjs` reads
real clients without changing anything and prints counts only, for anyone who
wants to check theirs.

## Limitations

- Three clients at most; one device per client, not per torrent.
- No deletion of torrents or files, by design.
- Deluge has no alternative speed limits; its category filter needs the Label
  plugin. Transmission's category is its first label (4.0 and later).
- rTorrent has no alternative speed limits either, and no free space of its
  own (the one of the partition of a torrent is shown); the SCGI socket
  without a web server is not supported.
- Torrents added or finished while the integration is stopped are not
  announced.
- Feature names are fixed when a device is added (Gladys rule).

## Development

```bash
npm ci
npm run format:check
npm run lint
npm test
npm run test:real          # optional: real clients, see CLAUDE.md
npx -y github:GladysAssistant/integration-store --skip-image-check .
```

The tests use the fake Gladys of the SDK (`@gladysassistant/integration-sdk/testing`)
and in-memory torrent clients (`test/helpers/fakeClients.js`) seeded with the
recorded answers. See [`CLAUDE.md`](CLAUDE.md) for the project rules. Versions
are released by the Release workflow (Actions → Release), never by hand.

## Credits

- [qBittorrent](https://www.qbittorrent.org) (GPL-2.0+): the
  [WebUI API documentation](<https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-(qBittorrent-4.1)>)
  of its wiki. [Transmission](https://transmissionbt.com) (GPL-2.0/3.0): the
  [RPC specification](https://github.com/transmission/transmission/blob/main/docs/rpc-spec.md).
  [Deluge](https://deluge-torrent.org) (GPL-3.0): the documentation of its web
  interface. [rTorrent](https://github.com/rakshasa/rtorrent) (GPL-2.0): its
  [XML-RPC reference](https://rtorrent-docs.readthedocs.io/en/latest/cmd-ref.html).
  No code of these programs was copied; their answers were recorded
  for the tests.
- [qbittorrent-api](https://github.com/rmartin16/qbittorrent-api) by Russell
  Martin (MIT): the edge cases of the qBittorrent API (no Referer nor Origin
  header behind a reverse proxy, `stop`/`start` from Web API 2.11.0).
- Home Assistant's
  [`qbittorrent`](https://github.com/home-assistant/core/tree/dev/homeassistant/components/qbittorrent),
  [`transmission`](https://github.com/home-assistant/core/tree/dev/homeassistant/components/transmission)
  [`deluge`](https://github.com/home-assistant/core/tree/dev/homeassistant/components/deluge)
  and [`rtorrent`](https://github.com/home-assistant/core/tree/dev/homeassistant/components/rtorrent)
  integrations (Apache-2.0): the choice of sensors and switches.
- Cover: the official logos of the three programs, the Deluge one from
  [`deluge/ui/data/pixmaps/deluge.svg`](https://github.com/deluge-torrent/deluge/blob/develop/deluge/ui/data/pixmaps/deluge.svg)
  in the Deluge repository (GPL-3.0).
- The architecture, the conformity and language tests follow
  [gladys-pihole](https://github.com/guim31/gladys-pihole) and
  [gladys-wled](https://github.com/guim31/gladys-wled).

## Disclaimer

This project is not affiliated with, endorsed or sponsored by the qBittorrent,
Transmission, Deluge or rTorrent projects. Their names belong to their owners.

## License

Apache-2.0
