# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

What the integration holds, and where:

- **Secrets**: the user names and passwords of the torrent clients live in the
  Gladys configuration of the integration (password fields are `secret`). The
  integration keeps them in memory only, sends them only to the address typed
  for that client (qBittorrent login form, Transmission and rTorrent basic
  authentication, Deluge login), and never writes them to the logs. The session cookies of
  qBittorrent and Deluge stay in memory and are closed when the integration
  stops.
- **`/data`**: nothing is written there.
- **Network**: the integration only talks to the client addresses of the
  configuration, on the local network, and to Gladys. Certificates are checked
  unless _Accept self-signed certificates_ is ticked. It never fetches a URL
  given by a scene: _Add a magnet link_ accepts `magnet:` links only, and is
  off unless allowed in the configuration.
- **Commands**: pause, resume, alternative speed limits and adding a magnet
  link. The integration has no code that deletes a torrent or a file.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
and the torrent clients the integration talks to (qBittorrent, Transmission,
Deluge, rTorrent and the web server in front of it).
