function createIntegrationSettings(database) {
  const settings = database.collection('integration_settings');

  async function getGoogleAuthSettings(configured) {
    const setting = await settings.findOne({ _id: 'google_auth' });
    const enabled = setting?.enabled === true;
    return {
      configured,
      enabled,
      active: configured && enabled,
    };
  }

  return {
    getGoogleAuthSettings,

    async isGoogleAuthEnabled(configured) {
      const status = await getGoogleAuthSettings(configured);
      return status.active;
    },

    async setGoogleAuthEnabled(enabled) {
      if (typeof enabled !== 'boolean') throw new Error('Choose whether Google sign-in should be enabled or disabled.');
      await settings.updateOne(
        { _id: 'google_auth' },
        { $set: { enabled, updated_at: new Date().toISOString() } },
        { upsert: true },
      );
    },
  };
}

module.exports = { createIntegrationSettings };
