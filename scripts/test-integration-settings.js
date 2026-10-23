const assert = require('node:assert/strict');
const express = require('express');
const pages = require('../src/routes/pages');
const { createIntegrationSettings } = require('../src/services/integration-settings');

async function testSettingsService() {
  let setting = null;
  const service = createIntegrationSettings({
    collection(name) {
      assert.equal(name, 'integration_settings');
      return {
        findOne: async (filter) => filter._id === 'google_auth' ? setting : null,
        updateOne: async (filter, update) => {
          assert.equal(filter._id, 'google_auth');
          setting = { _id: 'google_auth', ...update.$set };
        },
      };
    },
  });

  assert.deepEqual(await service.getGoogleAuthSettings(true), {
    configured: true, enabled: false, active: false,
  });
  assert.equal(await service.isGoogleAuthEnabled(true), false);
  await service.setGoogleAuthEnabled(true);
  assert.deepEqual(await service.getGoogleAuthSettings(true), {
    configured: true, enabled: true, active: true,
  });
  assert.deepEqual(await service.getGoogleAuthSettings(false), {
    configured: false, enabled: true, active: false,
  });
  assert.equal(await service.isGoogleAuthEnabled(false), false);
  await service.setGoogleAuthEnabled(false);
  assert.equal((await service.getGoogleAuthSettings(true)).active, false);
  await assert.rejects(service.setGoogleAuthEnabled('true'), /Choose whether/);
}

async function testAdminRoute() {
  const savedSettings = [];
  const admin = { id: 'admin-1', role_name: 'admin' };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => {
    req.session = { user: admin };
    next();
  });
  app.locals.services = {
    auth: {
      requireRole(user, roles) {
        if (!roles.includes(user.role_name)) throw new Error('Forbidden');
      },
    },
    googleOAuth: { enabled: true },
    integrationSettings: {
      setGoogleAuthEnabled: async (enabled) => savedSettings.push(enabled),
      getGoogleAuthSettings: async () => ({ configured: true, enabled: false, active: false }),
      isGoogleAuthEnabled: async () => false,
    },
    notifications: {},
  };
  app.use(pages);
  app.use((error, _req, res, _next) => res.status(500).send(error.message));

  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/index.php?page=admin-settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ action: 'enable_google_auth' }),
      redirect: 'manual',
    });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/index.php?page=admin-settings&updated=enabled');
    assert.deepEqual(savedSettings, [true]);

    app.locals.services.googleOAuth.enabled = false;
    const unconfiguredResponse = await fetch(`http://127.0.0.1:${port}/index.php?page=admin-settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ action: 'enable_google_auth' }),
      redirect: 'manual',
    });
    assert.equal(unconfiguredResponse.status, 302);
    assert.equal(unconfiguredResponse.headers.get('location'), '/index.php?page=admin-settings&error=not-configured');
    assert.deepEqual(savedSettings, [true]);
    console.log('Integration settings checks passed.');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function run() {
  await testSettingsService();
  await testAdminRoute();
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
