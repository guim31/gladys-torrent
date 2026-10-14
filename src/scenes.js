// -----------------------------------------------------------------------------
// Scene action handlers (manifest `scene_actions`, Gladys 5.1+).
//
// The use case: a film starts on the TV, a video call begins → slow the
// downloads down or pause them, and back when it ends. Every client at once
// by default, or the one chosen. The alternative speed switch of a device is
// already a Gladys scene action ("control a device"), but one client at a
// time. Adding a magnet link is off unless the configuration allows it.
// Gladys applies the field defaults to scene actions.
// -----------------------------------------------------------------------------

export const ALT_SPEED_STATES = Object.freeze({ ON: 'on', OFF: 'off' });

export const SCENE_ACTIONS = {
  async pause_all(hub, { fields = {} }) {
    return { clients: await hub.pauseAll(fields.device || null) };
  },

  async resume_all(hub, { fields = {} }) {
    return { clients: await hub.resumeAll(fields.device || null) };
  },

  async set_alt_speed(hub, { fields = {} }) {
    const enabled = fields.state !== ALT_SPEED_STATES.OFF;
    return { clients: await hub.setAltSpeed(fields.device || null, enabled) };
  },

  async add_magnet(hub, { fields = {} }) {
    return { hash: await hub.addMagnet(fields.device || null, fields.magnet) };
  },
};
