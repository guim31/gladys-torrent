# qBittorrent / Transmission / Deluge / rTorrent

Follow and control the torrent clients of your home server from Gladys, over
your local network: **qBittorrent**, **Transmission**, **Deluge** and
**rTorrent**. See the
download and upload speeds and the downloads in progress, slow everything down
when a film starts on the TV, pause it all, and get a notification when a
download is finished.

> **Tested on the real programs, not yet in a real home: feedback welcome.**
> This integration was tested against qBittorrent 4.6.3 and 5.2.4,
> Transmission 4.0.5, Deluge 2.1 and rTorrent 0.16.25 (with ruTorrent)
> running next to it, with downloads between them, but not yet in a real Gladys installation with your NAS, your reverse
> proxy or your Docker setup. If something does not work as described, please
> say so on the [Gladys forum](https://community.gladysassistant.com) or in the
> [issues](https://github.com/guim31/gladys-torrent/issues).

The integration never deletes a torrent nor a file. Its commands are pause,
resume and the alternative speed limits, all reversible; adding a magnet link
is off unless you allow it.

## What you need

- Gladys Assistant 5.1.0 or later.
- One to three torrent clients reachable from Gladys, any mix:
  - **qBittorrent** 4.1 or later with its **Web UI** on (Tools → Options →
    Web UI), or `qbittorrent-nox`;
  - **Transmission** (2.80 or later) with **remote access** on: the daemon
    `transmission-daemon`, or Preferences → Remote in the desktop versions;
  - **Deluge** with its **web interface** (`deluge-web`, port 8112),
    connected to its daemon (the integration does not use the daemon port
    58846 directly);
  - **rTorrent** 0.9 or later with its **XML-RPC published over HTTP** by a
    web server, as ruTorrent, Flood and seedboxes do (an address ending in
    `/RPC2`). The SCGI port or socket of rTorrent alone is not enough: it
    does not speak HTTP.
- The user name and password of the web interface (Deluge: the password only,
  `deluge` until you change it; rTorrent: the HTTP login of the web server,
  if it asks for one).

On **Transmission**, the address of Gladys must be allowed: either add it to
`rpc-whitelist` in `settings.json`, or turn the whitelist off
(`rpc-whitelist-enabled: false`) and keep a password. In Docker images
(linuxserver.io…), the variables `USER`, `PASS` and `WHITELIST` do it.

## Set up

1. Install the integration from the Gladys catalog.
2. In **Configuration**, for your first client, choose the **Software**, enter
   its **Address** (for example `192.168.1.10:8080`), the **User name** and the
   **Password**, and optionally a **Name**. Without a port, the integration
   uses the default one of the software: 8080 for qBittorrent, 9091 for
   Transmission, 8112 for Deluge, 80 for rTorrent (whose address gets `/RPC2`
   unless its path already ends with it: `192.168.1.10:8000` for the
   `crazymax/rtorrent-rutorrent` image). Two or three clients? Fill in the _Second
   client_ and _Third client_ sections too: another software, or another
   instance of the same one.
3. Save, then click **Test the connection**: the message under the button says,
   for each client, whether it answers, its version and its torrents.
4. Open the **Discover** tab: one device per client. Click **Add**, pick a
   room, save.

The address can carry a path when the client is behind a reverse proxy
(`https://nas.example.com/qbittorrent`), or be copied from the browser
(`http://192.168.1.10:9091/transmission/web/` works for Transmission).

Options:

- **Accept self-signed certificates**: for an `https://` address whose
  certificate was not signed by an authority (common on a NAS).
- **Refresh interval**: how often the clients are read, from 10 seconds to 2
  minutes (30 seconds by default). It is also the delay of the triggers.
- **Allow adding magnet links**: lets the scenes add a torrent (off by
  default, see the _Add a magnet link_ action).
- **Language of the device texts**: English, French, German or Spanish, for the
  feature names (given when a device is added) and the list of downloads
  (French by default).

## The device of each client

| Feature                  | What it is                                                                     |
| ------------------------ | ------------------------------------------------------------------------------ |
| Download speed           | Speed of all the downloads, in kB/s                                            |
| Upload speed             | Speed of all the uploads (seeding), in kB/s                                    |
| Torrents in progress     | Torrents not finished and not paused: downloading, queued, stalled, checked    |
| Paused torrents          | Torrents not finished and paused                                               |
| Completed torrents       | Torrents entirely downloaded, seeding or not, paused or not                    |
| Current downloads        | Text: the first three downloads in progress with their percentage              |
| Free space               | Free space of the download folder, in GB                                       |
| Alternative speed limits | Switch: the alternative speed limits of the client (not on Deluge or rTorrent) |
| Client connected         | 1 while the client answers, 0 when it does not                                 |

The three counters add up to the total number of torrents. A torrent paused
once its sharing ratio is reached counts as completed, not as paused.

_Alternative speed limits_ are the slower limits you set in the client itself:
in qBittorrent, Options → Speed → _Alternative rate limits_; in Transmission,
the _turtle mode_ (Preferences → Speed → _Alternative speed limits_). Deluge
and rTorrent have no such mode: their devices have no switch.

On rTorrent, _Pause all_ stops the torrents (ruTorrent's _Stop_) and _Resume
all_ starts them again, and also resumes the ones paused in ruTorrent. A
torrent rTorrent stopped with an error message (missing files…) counts as in
progress, not as paused. rTorrent has no free space of its own: the
integration shows the free space of the partition of a torrent in the default
download folder, and none while there is no torrent.

In the list of downloads, the ones receiving data come first, the fastest
first. A percentage is rounded down: 99 % until the end.

## Dashboard

The **Torrents** widget shows the download and upload speeds, the number of
torrents in progress, the downloads in progress with their percentage and
speed, and the paused and completed counts. It sums every client, or shows
the one chosen in its settings. Three buttons:

- **Pause all**: pauses every torrent;
- **Resume all**: resumes every torrent;
- **Alternative speed**: turns the alternative speed limits on, or off when
  they are on (a check mark shows it). Not shown for Deluge or rTorrent alone.

The widget works as soon as the integration is configured, even before the
devices are added.

## Scenes

### Triggers

- **Download completed**: a torrent finished downloading. A torrent added with
  its files already on disk (checked, then complete) does not count, nor a
  finished torrent checked again. Filters: the client, and the **category**
  (qBittorrent) or **label** (Transmission 4, Deluge with the Label plugin,
  ruTorrent).
  Variables: the torrent name, the client name, the category and the size in
  GB.
- **New torrent added**: a torrent was added to the client, by anyone (you,
  Sonarr, Radarr, a browser extension…). A magnet link is announced once its
  name is known. Same filters and variables.

The torrents present when the integration starts are not announced: a torrent
added or finished while the integration (or Gladys) was stopped is not
announced. While a client does not answer, the integration remembers its
torrents: what finished in the meantime is announced when it answers again.

### Actions

- **Pause all torrents**: on one client, or on every client.
- **Resume all torrents**: on one client, or on every client.
- **Alternative speed limits**: _On_ or _Off_, on one client or on every
  client that has them (Deluge and rTorrent are skipped). The output is the number of
  clients that accepted.
- **Add a magnet link**: adds a torrent by its `magnet:?xt=urn:btih:…` link,
  on the chosen client or the first one of the configuration. Only when
  **Allow adding magnet links** is ticked: whoever can edit a scene could
  otherwise start a download. Only magnet links are accepted, never an
  `http` address the client would fetch. The output is the info hash.

### Scene ideas

- **A film starts**: when the TV or the media player starts playing, run
  _Alternative speed limits_ → _On_; when it stops, _Off_.
- **Video call**: from a calendar event or a button, _Pause all torrents_,
  then _Resume all torrents_ an hour later.
- **Film ready**: on _Download completed_ with the category `films`, send a
  message "{{triggerEvent.data.name}} is ready to watch".
- **Disk almost full**: when _Free space_ drops under 20 GB, pause everything
  and send a message.
- **Client down**: when _Client connected_ goes to 0 for 10 minutes, send a
  message.

## Refresh and load

The integration reads each client on its own timer (every 30 seconds by
default), not through the Gladys poller. One reading is light: qBittorrent
sends only what changed since the previous reading, Transmission answers four
small calls with only the fields used, Deluge and rTorrent one call each. A client that stops
answering is read again 15 seconds later. A value that does not change is still
sent to Gladys every 6 hours.

The APIs are local, without quota. qBittorrent, however, bans the address of
Gladys after 5 failed logins (for an hour by default): after a refused
password, the integration waits 5 minutes, then 15, then an hour, then 6 hours
before trying again. Fixing the password in the configuration, or clicking
**Test the connection**, tries again at once.

## Troubleshooting

- **"does not answer"**: check the address and the port from the Gladys
  machine (`curl http://192.168.1.10:8080`), and that the client listens on
  the network, not only on `localhost`.
- **"user name or password refused"**: check them in the web interface of the
  client. On Deluge, it is the password of the web interface, not of the
  daemon.
- **"qBittorrent banned the address of Gladys"**: too many failed logins. Wait
  for the end of the ban (Options → Web UI → _Ban client after consecutive
  failures_), or restart qBittorrent, then fix the password.
- **"not on the RPC whitelist"** (Transmission): add the address of Gladys to
  `rpc-whitelist`, see _What you need_.
- **"no such client at this address"**: the software chosen does not match the
  address, or a reverse proxy serves it under a path you did not type.
- **"not connected to its daemon"** (Deluge): open the web interface, Connection
  Manager, and connect it to its daemon; the integration then connects it
  itself to the first daemon of the list.
- **rTorrent: "no such client at this address"**: the address must lead to
  the XML-RPC of rTorrent (`…/RPC2`, or `…/plugins/rpc/rpc.php` with the
  ruTorrent _rpc_ plugin), not to the ruTorrent page; ruTorrent's _httprpc_
  plugin speaks another protocol. Test it from the Gladys machine:
  `curl -u user:password -d '<methodCall><methodName>system.client_version</methodName></methodCall>' http://192.168.1.10/RPC2`.
- **qBittorrent behind a reverse proxy refuses the login**: turn off _Enable
  Host header validation_ or add the host to it (Options → Web UI), or allow
  the address of Gladys under _Bypass authentication for clients in
  whitelisted IP subnets_ and leave the user name and password empty.
- **The Discovery tab shows nothing**: no client is configured, or its address
  was not understood (said in the Configuration screen).
- **More details**: set the `LOG_LEVEL=debug` environment variable on the
  container to see every reading in the logs of the integration. Passwords and
  session cookies are never written.

## Limits

- Three clients at most. One device per client, not per torrent.
- No deletion of torrents or files, by design.
- Deluge: no alternative speed limits (none in Deluge itself); the Label
  plugin is needed for the category filter.
- rTorrent: no alternative speed limits; the free space is the one of the
  partition of a torrent; the category is the ruTorrent label; the SCGI
  socket reached without a web server is not supported.
- Transmission: the category is the first label (Transmission 4.0 and later).
- The speeds are those of the whole client, not of one torrent.
- The triggers depend on the refresh interval: a torrent added then removed
  between two readings is not seen.
- Feature names are set when the device is added: changing the language later
  renames nothing in Gladys.
- Not affiliated with the qBittorrent, Transmission, Deluge or rTorrent
  projects.
