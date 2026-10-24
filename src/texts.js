// -----------------------------------------------------------------------------
// Texts the integration sends to Gladys outside the widget (src/widgets.js):
// connection status, errors, the "Test the connection" report, scene action
// errors, the text feature when nothing downloads. Four languages, the four
// of the Gladys interface; German says "du", Spanish "usted".
// test/i18n.test.js checks every table.
// -----------------------------------------------------------------------------

import { ERROR_KINDS } from './clients/common.js';

export const LANGUAGE_FALLBACK = 'en';

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

// The text feature "Current downloads" when nothing downloads (Gladys
// ignores an empty text).
export const NO_DOWNLOAD = {
  en: 'No download in progress',
  fr: 'Aucun téléchargement en cours',
  de: 'Kein laufender Download',
  es: 'Ninguna descarga en curso',
};

export const CONNECTION_TEXT = {
  noClient: {
    en: 'Enter the address of your torrent client in the configuration.',
    fr: "Saisissez l'adresse de votre client torrent dans la configuration.",
    de: 'Gib die Adresse deines Torrent-Clients in der Konfiguration ein.',
    es: 'Introduzca la dirección de su cliente torrent en la configuración.',
  },
  invalidUrl: {
    en: 'Address not understood, e.g. 192.168.1.10:8080',
    fr: 'Adresse incomprise, ex. 192.168.1.10:8080',
    de: 'Adresse nicht verstanden, z. B. 192.168.1.10:8080',
    es: 'Dirección no válida, p. ej. 192.168.1.10:8080',
  },
};

// One short explanation per error kind (src/clients/common.js).
export const ERROR_TEXT = {
  [ERROR_KINDS.UNREACHABLE]: {
    en: 'does not answer',
    fr: 'ne répond pas',
    de: 'antwortet nicht',
    es: 'no responde',
  },
  [ERROR_KINDS.TLS]: {
    en: 'certificate refused: tick "Accept self-signed certificates"',
    fr: 'certificat refusé : cochez « Accepter les certificats auto-signés »',
    de: 'Zertifikat abgelehnt: Aktiviere „Selbstsignierte Zertifikate akzeptieren“',
    es: 'certificado rechazado: marque «Aceptar certificados autofirmados»',
  },
  [ERROR_KINDS.AUTH]: {
    en: 'user name or password refused',
    fr: "nom d'utilisateur ou mot de passe refusé",
    de: 'Benutzername oder Passwort abgelehnt',
    es: 'nombre de usuario o contraseña rechazados',
  },
  [ERROR_KINDS.BANNED]: {
    en: 'qBittorrent banned the address of Gladys after failed logins',
    fr: "qBittorrent a banni l'adresse de Gladys après des échecs de connexion",
    de: 'qBittorrent hat die Adresse von Gladys nach Fehlversuchen gesperrt',
    es: 'qBittorrent ha bloqueado la dirección de Gladys tras varios fallos',
  },
  [ERROR_KINDS.FORBIDDEN]: {
    en: 'the address of Gladys is not on the RPC whitelist',
    fr: "l'adresse de Gladys n'est pas dans la liste blanche RPC",
    de: 'die Adresse von Gladys steht nicht auf der RPC-Whitelist',
    es: 'la dirección de Gladys no está en la lista blanca RPC',
  },
  [ERROR_KINDS.NOT_FOUND]: {
    en: 'no such client at this address: check the software and the port',
    fr: 'aucun client de ce type à cette adresse : vérifiez le logiciel et le port',
    de: 'kein solcher Client unter dieser Adresse: Prüfe Software und Port',
    es: 'ningún cliente de este tipo en esta dirección: compruebe el programa y el puerto',
  },
  [ERROR_KINDS.NO_DAEMON]: {
    en: 'the Deluge web interface is not connected to its daemon',
    fr: "l'interface web de Deluge n'est pas connectée à son démon",
    de: 'die Deluge-Weboberfläche ist nicht mit ihrem Daemon verbunden',
    es: 'la interfaz web de Deluge no está conectada a su demonio',
  },
  [ERROR_KINDS.UNSUPPORTED]: {
    en: 'not available on this software',
    fr: 'non disponible avec ce logiciel',
    de: 'mit dieser Software nicht verfügbar',
    es: 'no disponible con este programa',
  },
  [ERROR_KINDS.REJECTED]: {
    en: 'command refused by the client (torrent already there?)',
    fr: 'commande refusée par le client (torrent déjà présent ?)',
    de: 'Befehl vom Client abgelehnt (Torrent schon vorhanden?)',
    es: 'orden rechazada por el cliente (¿torrent ya presente?)',
  },
  [ERROR_KINDS.HTTP]: {
    en: 'unexpected answer, see the logs',
    fr: 'réponse inattendue, voir les logs',
    de: 'unerwartete Antwort, sieh in den Protokollen nach',
    es: 'respuesta inesperada, consulte los registros',
  },
};

// The "Test the connection" report, one line per client.
export const REPORT_TEXT = {
  en: {
    ok: 'OK',
    torrents: (downloading, total) => `${downloading} in progress out of ${total} torrents`,
    altSpeed: 'alternative speed on',
  },
  fr: {
    ok: 'OK',
    torrents: (downloading, total) => `${downloading} en cours sur ${total} torrents`,
    altSpeed: 'vitesse alternative active',
  },
  de: {
    ok: 'OK',
    torrents: (downloading, total) => `${downloading} laufend von ${total} Torrents`,
    altSpeed: 'alternative Geschwindigkeit an',
  },
  es: {
    ok: 'OK',
    torrents: (downloading, total) => `${downloading} en curso de ${total} torrents`,
    altSpeed: 'velocidad alternativa activa',
  },
};

// Errors of the scene actions and widget buttons (shown in Gladys).
export const ACTION_TEXT = {
  noClient: {
    en: 'No torrent client is configured.',
    fr: "Aucun client torrent n'est configuré.",
    de: 'Kein Torrent-Client ist konfiguriert.',
    es: 'No hay ningún cliente torrent configurado.',
  },
  unknownClient: {
    en: 'This torrent client is no longer in the configuration.',
    fr: "Ce client torrent n'est plus dans la configuration.",
    de: 'Dieser Torrent-Client ist nicht mehr in der Konfiguration.',
    es: 'Este cliente torrent ya no está en la configuración.',
  },
  failed: {
    en: 'No torrent client accepted the command.',
    fr: "Aucun client torrent n'a accepté la commande.",
    de: 'Kein Torrent-Client hat den Befehl angenommen.',
    es: 'Ningún cliente torrent ha aceptado la orden.',
  },
  noAltSpeed: {
    en: 'Deluge and rTorrent have no alternative speed limits: choose a qBittorrent or Transmission client.',
    fr: "Deluge et rTorrent n'ont pas de limites de vitesse alternatives : choisissez un client qBittorrent ou Transmission.",
    de: 'Deluge und rTorrent haben keine alternativen Geschwindigkeitslimits: Wähle einen qBittorrent- oder Transmission-Client.',
    es: 'Deluge y rTorrent no tienen límites de velocidad alternativos: elija un cliente qBittorrent o Transmission.',
  },
  magnetDisabled: {
    en: 'Adding torrents is off: tick "Allow adding magnet links" in the configuration.',
    fr: "L'ajout de torrents est désactivé : cochez « Autoriser l'ajout de liens magnet » dans la configuration.",
    de: 'Das Hinzufügen von Torrents ist aus: Aktiviere „Magnet-Links erlauben“ in der Konfiguration.',
    es: 'Añadir torrents está desactivado: marque «Permitir añadir enlaces magnet» en la configuración.',
  },
  notMagnet: {
    en: 'This is not a magnet link (magnet:?xt=urn:btih:…).',
    fr: "Ce n'est pas un lien magnet (magnet:?xt=urn:btih:…).",
    de: 'Das ist kein Magnet-Link (magnet:?xt=urn:btih:…).',
    es: 'Esto no es un enlace magnet (magnet:?xt=urn:btih:…).',
  },
};

/** "Name: text", with the space French puts before a colon. */
export const labelled = (name, text, language) =>
  `${name}${language === 'fr' ? ' : ' : ': '}${text}`;
export const pick = (text, language) => text[language] ?? text[LANGUAGE_FALLBACK];
