const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { test } = require('node:test');
const { createGoogleCalendar } = require('../../src/services/google-calendar');
const { createIntegrationCaller } = require('../../src/services/integration-calls');

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  .export({ format: 'pem', type: 'pkcs8' }).toString();

function settings(active = true) {
  return {
    async getIntegration() {
      return {
        enabled: active,
        configured: true,
        active,
        settings: {
          calendar_id: 'pickup-calendar@example.test',
          service_account_email: 'calendar-bot@example.iam.gserviceaccount.com',
          private_key: privateKey,
          time_zone: 'Asia/Manila',
          office_location: 'Buksu SSC Office',
          pickup_open_time: '08:00',
          pickup_close_time: '17:00',
          pickup_monday: true,
          pickup_tuesday: true,
          pickup_wednesday: true,
          pickup_thursday: true,
          pickup_friday: true,
          pickup_saturday: true,
          pickup_sunday: false,
        },
      };
    },
  };
}

function createHarness({ active = true, calendarFailure = null } = {}) {
  const events = new Map();
  const operations = [];
  const statuses = [];
  const auditEvents = [];
  const claim = {
    id: 'claim-123',
    status: 'approved',
    pickup_at: '2030-01-07T08:30:00.000Z',
    pickup_location: 'Buksu SSC Office',
    pickup_time_zone: 'Asia/Manila',
    calendar_event_id: null,
    calendar_sync_status: 'pending',
    user_id: 'user-123',
    claimant: { email: 'claimant@example.test' },
    claim_details: 'PRIVATE VERIFICATION DETAILS',
    claimant_phone: 'PRIVATE PHONE',
  };
  const googleClient = {
    auth: { JWT: class JWT {} },
    calendar() {
      return {
        calendars: {
          async get() {
            operations.push('calendar.get');
            if (calendarFailure) throw { response: { status: calendarFailure } };
            return { data: { id: 'pickup-calendar@example.test' } };
          },
        },
        events: {
          async get({ eventId }) {
            operations.push('event.get');
            const event = events.get(eventId);
            if (!event) throw { response: { status: 404 } };
            return { data: event };
          },
          async insert({ requestBody }) {
            operations.push('event.insert');
            if (events.has(requestBody.id)) throw { response: { status: 409 } };
            events.set(requestBody.id, structuredClone(requestBody));
            return { data: requestBody };
          },
          async update({ eventId, requestBody }) {
            operations.push('event.update');
            events.set(eventId, structuredClone(requestBody));
            return { data: requestBody };
          },
          async delete({ eventId }) {
            operations.push('event.delete');
            if (!events.delete(eventId)) throw { response: { status: 404 } };
          },
        },
      };
    },
  };
  const integrationSettings = {
    ...settings(active),
    async updateClaimCalendarStatus(id, status, eventId) {
      assert.equal(id, claim.id);
      claim.calendar_sync_status = status;
      if (eventId) claim.calendar_event_id = eventId;
      statuses.push(status);
    },
    async claimCalendarSyncFailureAudit() { return true; },
    async recordIntegrationSuccess() {},
    async recordIntegrationFailure(_id, failure) { auditEvents.push({ failure }); },
    async claimIntegrationFailureAudit() { return true; },
  };
  const items = {
    async updateClaimCalendarStatus(id, status, eventId) {
      await integrationSettings.updateClaimCalendarStatus(id, status, eventId);
    },
    async findCalendarClaim(id) { return id === claim.id ? claim : null; },
    async findCalendarClaimByItem() { return claim; },
  };
  const audit = {
    async logAction(event) { auditEvents.push(event); },
  };
  const callIntegration = createIntegrationCaller({ integrationSettings, audit, timeoutMs: 200 });
  const calendar = createGoogleCalendar({
    integrationSettings,
    items,
    notifications: { async create() {} },
    email: { async sendPickupNotification() { return true; } },
    audit,
    callIntegration,
    client: googleClient,
  });
  return { calendar, claim, events, operations, statuses, auditEvents };
}

test('calendar sync creates one private-data-free event and retry/reschedule updates it', async () => {
  const harness = createHarness();
  const first = await harness.calendar.syncApprovedClaim(harness.claim);
  const eventId = first.eventId;
  assert.equal(first.status, 'synced');
  assert.equal(harness.events.size, 1);
  const original = harness.events.get(eventId);
  assert.equal(original.summary, 'Item pickup – Claim #claim-123');
  assert.equal(original.location, 'Buksu SSC Office');
  assert.equal(original.start.timeZone, 'Asia/Manila');
  assert.deepEqual(original.reminders.overrides, [{ method: 'popup', minutes: 10 }]);
  assert.equal(original.description, 'Claim reference: #claim-123\nPickup location: Buksu SSC Office');
  assert.equal(JSON.stringify(original).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(original).includes('claimant@example.test'), false);

  harness.claim.calendar_event_id = eventId;
  await harness.calendar.syncApprovedClaim(harness.claim);
  assert.equal(harness.operations.filter((operation) => operation === 'event.insert').length, 1);

  harness.claim.pickup_at = '2030-01-07T09:00:00.000Z';
  await harness.calendar.syncApprovedClaim(harness.claim);
  assert.equal(harness.events.size, 1);
  assert.equal(harness.events.get(eventId).start.dateTime, harness.claim.pickup_at);
  assert.equal(harness.operations.filter((operation) => operation === 'event.update').length, 2);
});

test('calendar cleanup is safe when retried after the event was deleted', async () => {
  const harness = createHarness();
  const { eventId } = await harness.calendar.syncApprovedClaim(harness.claim);
  harness.claim.calendar_event_id = eventId;
  await harness.calendar.cleanupClaim(harness.claim);
  await harness.calendar.cleanupClaim(harness.claim);
  assert.equal(harness.events.size, 0);
  assert.equal(harness.operations.filter((operation) => operation === 'event.delete').length, 2);
  assert.equal(harness.claim.calendar_sync_status, 'skipped');
});

test('calendar provider failure is rate-audited, sanitized, and returns a failed sync status', async () => {
  const harness = createHarness({ calendarFailure: 404 });
  const result = await harness.calendar.syncApprovedClaim(harness.claim);
  assert.equal(result.status, 'failed');
  assert.equal(harness.claim.calendar_sync_status, 'failed');
  assert.ok(harness.auditEvents.some(({ failure }) => failure?.code === 'calendar_not_shared'));
  const serialized = JSON.stringify(harness.auditEvents);
  assert.equal(serialized.includes(privateKey), false);
  assert.equal(serialized.includes('PRIVATE VERIFICATION DETAILS'), false);
});

test('calendar test connection performs only a read and reports a safe sharing hint', async () => {
  const passed = createHarness();
  assert.equal(await passed.calendar.testConnection(), true);
  assert.deepEqual(passed.operations, ['calendar.get']);

  const failed = createHarness({ calendarFailure: 404 });
  await assert.rejects(failed.calendar.testConnection(), /Calendar not shared with the service account/);
});

test('pickup validation enforces future dates, local hours, and configured weekdays', async () => {
  const harness = createHarness();
  const valid = await harness.calendar.validatePickup({
    pickup_date: '2030-01-07',
    pickup_time: '16:30',
  });
  assert.equal(valid.pickup_location, 'Buksu SSC Office');
  assert.equal(valid.pickup_time_zone, 'Asia/Manila');
  await assert.rejects(harness.calendar.validatePickup({
    pickup_date: '2020-01-06',
    pickup_time: '10:00',
  }), /future/);
  await assert.rejects(harness.calendar.validatePickup({
    pickup_date: '2030-01-07',
    pickup_time: '17:00',
  }), /Pickup time must fit/);
  await assert.rejects(harness.calendar.validatePickup({
    pickup_date: '2030-01-06',
    pickup_time: '10:00',
  }), /not available on that day/);
});

test('disabled Calendar integration skips event creation without provider calls', async () => {
  const harness = createHarness({ active: false });
  assert.deepEqual(await harness.calendar.syncApprovedClaim(harness.claim), { status: 'skipped' });
  assert.deepEqual(harness.operations, []);
  assert.equal(harness.claim.calendar_sync_status, 'skipped');
});

test('calendar links and ICS contain only claim reference and pickup location', () => {
  const harness = createHarness();
  const url = harness.calendar.googleCalendarUrl(harness.claim);
  assert.match(url, /calendar\.google\.com\/calendar\/render\?action=TEMPLATE/);
  assert.equal(decodeURIComponent(url).includes('PRIVATE VERIFICATION DETAILS'), false);
  const ics = harness.calendar.createIcs(harness.claim);
  assert.match(ics, /SUMMARY:Item pickup/);
  assert.match(ics, /DESCRIPTION:Claim reference: #claim-123\\nPickup location: Buksu SSC Office/);
  assert.equal(ics.includes('claimant@example.test'), false);
  assert.equal(ics.includes('PRIVATE'), false);
});
