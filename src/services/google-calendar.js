const { createPrivateKey } = require('node:crypto');
const googleClient = require('@googleapis/calendar');
const {
  IntegrationError,
  UserProviderError,
  providerFailure,
} = require('./integration-calls');
const {
  PICKUP_DURATION_MINUTES,
  deterministicEventId,
  formatPickupDateTime,
  googleCalendarUrl,
} = require('./calendar-links');

const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
];
const FAILURE_AUDIT_WINDOW_MS = 10 * 60 * 1000;

function createGoogleCalendar({
  integrationSettings,
  items,
  notifications,
  email,
  audit,
  callIntegration,
  client = googleClient,
}) {
  async function testConnection(auditContext, settings = null, options = {}) {
    const integration = settings
      ? { configured: true, active: true, settings }
      : await integrationSettings.getIntegration('google_calendar');
    if (!integration.configured) {
      const error = new Error('Configure all required saved Google Calendar fields before testing.');
      error.status = 400;
      throw error;
    }
    return callIntegration('google_calendar', async ({ signal }) => {
      const calendar = createCalendarClient(integration.settings, client);
      try {
        await calendar.calendars.get({ calendarId: integration.settings.calendar_id }, { signal });
      } catch (error) {
        throw providerError(error);
      }
      return true;
    }, auditContext, options);
  }

  async function syncApprovedClaim(claim, auditContext = {}) {
    if (!claim.pickup_at || !claim.pickup_location) {
      await items.updateClaimCalendarStatus(claim.id, 'skipped', null);
      return { status: 'skipped' };
    }
    const integration = await integrationSettings.getIntegration('google_calendar');
    if (!integration.active) {
      await items.updateClaimCalendarStatus(claim.id, 'skipped', claim.calendar_event_id || null);
      return { status: 'skipped' };
    }

    const eventId = claim.calendar_event_id || deterministicEventId(claim.id);
    await items.updateClaimCalendarStatus(claim.id, 'pending', eventId);
    let action;
    try {
      action = await callIntegration('google_calendar', async ({ signal }) => {
        const calendar = createCalendarClient(integration.settings, client);
        const event = buildEvent(claim, eventId);
        try {
          await calendar.calendars.get({
            calendarId: integration.settings.calendar_id,
          }, { signal });
        } catch (error) {
          throw providerError(error);
        }
        try {
          await calendar.events.get({
            calendarId: integration.settings.calendar_id,
            eventId,
          }, { signal });
          await calendar.events.update({
            calendarId: integration.settings.calendar_id,
            eventId,
            requestBody: event,
          }, { signal });
          return 'calendar.event_update';
        } catch (error) {
          if (!isMissingEvent(error)) {
            if (Number(error?.response?.status || error?.status) === 409) {
              await calendar.events.update({
                calendarId: integration.settings.calendar_id,
                eventId,
                requestBody: event,
              }, { signal });
              return 'calendar.event_update';
            }
            throw providerError(error);
          }
        }
        try {
          await calendar.events.insert({
            calendarId: integration.settings.calendar_id,
            requestBody: event,
          }, { signal });
          return 'calendar.event_create';
        } catch (error) {
          if (Number(error?.response?.status || error?.status) !== 409) throw providerError(error);
          await calendar.events.update({
            calendarId: integration.settings.calendar_id,
            eventId,
            requestBody: event,
          }, { signal });
          return 'calendar.event_update';
        }
      }, auditContext);
      await items.updateClaimCalendarStatus(claim.id, 'synced', eventId);
      await logCalendarEvent(auditContext, action, claim.id, eventId);
      return { status: 'synced', eventId };
    } catch (error) {
      if (error instanceof IntegrationError || error instanceof UserProviderError) {
        await items.updateClaimCalendarStatus(claim.id, 'failed', eventId);
        await logSyncFailure(auditContext, claim.id, eventId);
        return { status: 'failed' };
      }
      throw error;
    }
  }

  async function cleanupClaim(claim, auditContext = {}, { notify = false } = {}) {
    const eventId = claim.calendar_event_id
      || (claim.pickup_at ? deterministicEventId(claim.id) : null);
    if (!eventId || !claim.pickup_at) {
      await items.updateClaimCalendarStatus(claim.id, 'skipped', eventId);
      return { status: 'skipped' };
    }

    const integration = await integrationSettings.getIntegration('google_calendar');
    if (!integration.configured || (!integration.enabled && claim.calendar_sync_status === 'skipped')) {
      await items.updateClaimCalendarStatus(claim.id, 'skipped', eventId);
      if (notify) await notifyCancellation(claim, auditContext);
      return { status: 'skipped' };
    }

    await items.updateClaimCalendarStatus(claim.id, 'pending', eventId);
    try {
      await callIntegration('google_calendar', async ({ signal }) => {
        const calendar = createCalendarClient(integration.settings, client);
        try {
          await calendar.calendars.get({
            calendarId: integration.settings.calendar_id,
          }, { signal });
        } catch (error) {
          throw providerError(error);
        }
        try {
          await calendar.events.delete({
            calendarId: integration.settings.calendar_id,
            eventId,
          }, { signal });
        } catch (error) {
          if (!isMissingEvent(error)) throw providerError(error);
        }
      }, auditContext);
      await items.updateClaimCalendarStatus(claim.id, 'skipped', eventId);
      await logCalendarEvent(auditContext, 'calendar.event_delete', claim.id, eventId);
      if (notify) await notifyCancellation(claim, auditContext);
      return { status: 'skipped' };
    } catch (error) {
      if (error instanceof IntegrationError || error instanceof UserProviderError) {
        await items.updateClaimCalendarStatus(claim.id, 'failed', eventId);
        await logSyncFailure(auditContext, claim.id, eventId);
        if (notify) await notifyCancellation(claim, auditContext);
        return { status: 'failed' };
      }
      throw error;
    }
  }

  async function cleanupForItem(itemId, auditContext = {}, options = {}) {
    const claim = await items.findCalendarClaimByItem(itemId);
    if (!claim) return { status: 'skipped' };
    return cleanupClaim(claim, auditContext, options);
  }

  async function retryClaim(claimId, auditContext = {}) {
    const claim = await items.findCalendarClaim(claimId);
    if (claim.status === 'approved' && claim.item_status === 'claimed' && !claim.item_deleted) {
      return syncApprovedClaim(claim, auditContext);
    }
    return cleanupClaim(claim, auditContext);
  }

  async function sendApprovalEmail(claim, auditContext = {}) {
    if (!claim.pickup_at || !claim.pickup_location || !claim.claimant?.email) return false;
    return sendPickupEmail(claim, 'approved', auditContext);
  }

  async function notifyCancellation(claim, auditContext = {}) {
    if (claim.claimant?.email) await sendPickupEmail(claim, 'cancelled', auditContext);
    try {
      await notifications.create(claim.user_id, {
        type: 'claim',
        title: 'Pickup cancelled',
        message: pickupNotice(claim, 'The scheduled pickup has been cancelled.'),
        href: `/index.php?page=claims&highlight=claim-${encodeURIComponent(claim.id)}`,
      });
    } catch {
      console.error('Pickup cancellation notification could not be created.');
    }
  }

  async function sendPickupEmail(claim, status, auditContext) {
    try {
      return await email.sendPickupNotification(
        claim.claimant.email,
        {
          claimId: claim.id,
          pickupAt: claim.pickup_at,
          pickupLocation: claim.pickup_location,
          timeZone: claim.pickup_time_zone || 'Asia/Manila',
          calendarUrl: googleCalendarUrl(claim),
          status,
        },
        auditContext,
      );
    } catch {
      console.error('Pickup email delivery failed.');
      return false;
    }
  }

  async function logCalendarEvent(auditContext, action, claimId, eventId) {
    try {
      await audit.logAction({
        ...auditContext,
        action,
        target_type: 'claim',
        target_id: claimId,
        new_value: { event_id: eventId },
      });
    } catch {
      console.error(`Calendar event audit update failed (${action}).`);
    }
  }

  async function logSyncFailure(auditContext, claimId, eventId) {
    try {
      if (!await integrationSettings.claimCalendarSyncFailureAudit(
        'google_calendar', new Date(Date.now() - FAILURE_AUDIT_WINDOW_MS),
      )) return;
      await audit.logAction({
        ...auditContext,
        action: 'calendar.sync_failed',
        target_type: 'claim',
        target_id: claimId,
        new_value: { event_id: eventId },
        result: 'failed',
      });
    } catch {
      console.error('Calendar sync failure audit update failed.');
    }
  }

  return {
    testConnection,
    syncApprovedClaim,
    cleanupClaim,
    cleanupForItem,
    retryClaim,
    sendApprovalEmail,
    googleCalendarUrl,
    formatPickupDateTime,
    validatePickup: (input) => validatePickup(input, integrationSettings),
    getPickupFormDefaults: async () => {
      const { settings } = await integrationSettings.getIntegration('google_calendar');
      return {
        office_location: settings.office_location,
        pickup_open_time: settings.pickup_open_time,
        pickup_close_time: settings.pickup_close_time,
        time_zone: settings.time_zone,
        pickup_days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
          .filter((day) => settings[`pickup_${day}`])
          .map((day) => day[0].toUpperCase() + day.slice(1))
          .join(', '),
      };
    },
    notifyRescheduled: async (claim, auditContext = {}) => {
      await notifications.create(claim.user_id, {
        type: 'claim',
        title: 'Pickup rescheduled',
        message: pickupNotice(claim, 'Your pickup appointment has been rescheduled.'),
        calendar_url: googleCalendarUrl(claim),
        href: `/index.php?page=claims&highlight=claim-${encodeURIComponent(claim.id)}`,
      });
      await sendPickupEmail(claim, 'rescheduled', auditContext);
    },
    sendCancellationEmail: (claim, auditContext = {}) => sendPickupEmail(claim, 'cancelled', auditContext),
    findUserCalendarClaim: (userId, claimId) => items.findCalendarClaimForUser(userId, claimId),
    createIcs: createIcs,
  };
}

function createCalendarClient(settings, googleClient) {
  const privateKey = normalizePrivateKey(settings.private_key);
  let auth;
  try {
    createPrivateKey(privateKey);
    auth = new googleClient.auth.JWT({
      email: settings.service_account_email,
      key: privateKey,
      scopes: CALENDAR_SCOPES,
    });
  } catch {
    throw providerFailure('invalid_credentials');
  }
  return googleClient.calendar({ version: 'v3', auth });
}

function normalizePrivateKey(value) {
  return String(value || '').replace(/\\n/g, '\n').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function buildEvent(claim, eventId) {
  const start = new Date(claim.pickup_at);
  const end = new Date(start.getTime() + PICKUP_DURATION_MINUTES * 60_000);
  const timeZone = claim.pickup_time_zone || 'Asia/Manila';
  return {
    id: eventId,
    summary: `Item pickup – Claim #${claim.id}`,
    description: `Claim reference: #${claim.id}\nPickup location: ${claim.pickup_location}`,
    location: claim.pickup_location,
    start: { dateTime: start.toISOString(), timeZone },
    end: { dateTime: end.toISOString(), timeZone },
    reminders: {
      useDefault: false,
      overrides: [{ method: 'popup', minutes: 10 }],
    },
  };
}

async function validatePickup(input, integrationSettings) {
  const integration = await integrationSettings.getIntegration('google_calendar');
  const date = String(input.pickup_date || '');
  const time = String(input.pickup_time || '');
  const location = String(input.pickup_location || integration.settings.office_location || '').trim();
  if (!date || !time) {
    const error = new Error('Enter both a pickup date and time.');
    error.status = 400;
    throw error;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    const error = new Error('Enter a valid pickup date and time.');
    error.status = 400;
    throw error;
  }
  const parsedDate = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
    const error = new Error('Enter a valid pickup date.');
    error.status = 400;
    throw error;
  }
  if (!location || location.length > 256 || /[\u0000-\u001f\u007f]/.test(location)) {
    const error = new Error('Enter a valid pickup location.');
    error.status = 400;
    throw error;
  }
  const { settings } = integration;
  const minute = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  const opening = timeToMinutes(settings.pickup_open_time);
  const closing = timeToMinutes(settings.pickup_close_time);
  if (minute < opening || minute + PICKUP_DURATION_MINUTES > closing) {
    const error = new Error(`Pickup time must fit within ${settings.pickup_open_time}–${settings.pickup_close_time}.`);
    error.status = 400;
    throw error;
  }
  const day = parsedDate.getUTCDay();
  const dayName = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][day];
  if (!settings[`pickup_${dayName}`]) {
    const error = new Error('Pickup is not available on that day.');
    error.status = 400;
    throw error;
  }
  const pickupAt = zonedDateTimeToUtc(date, time, settings.time_zone);
  if (pickupAt.getTime() <= Date.now()) {
    const error = new Error('Pickup time must be in the future.');
    error.status = 400;
    throw error;
  }
  return {
    pickup_at: pickupAt.toISOString(),
    pickup_location: location,
    pickup_time_zone: settings.time_zone,
  };
}

function zonedDateTimeToUtc(date, time, timeZone) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  const formatter = new Intl.DateTimeFormat('en', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  let candidate = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate))
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, Number(value)]));
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    candidate += target - represented;
  }
  const result = new Date(candidate);
  const parts = Object.fromEntries(formatter.formatToParts(result)
    .filter(({ type }) => type !== 'literal')
    .map(({ type, value }) => [type, Number(value)]));
  if (parts.year !== year || parts.month !== month || parts.day !== day
    || parts.hour !== hour || parts.minute !== minute) {
    const error = new Error('That local pickup time does not exist in the configured time zone.');
    error.status = 400;
    throw error;
  }
  return result;
}

function timeToMinutes(value) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''))) return 0;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

function providerError(error) {
  const status = Number(error?.response?.status || error?.status);
  if (status === 401 || status === 400) return providerFailure('invalid_credentials');
  if (status === 403 || status === 404) return providerFailure('calendar_not_shared');
  if ((status >= 500 && status <= 599) || status === 429) return providerFailure('provider_error');
  if (status >= 400 && status < 500) return new UserProviderError('Calendar rejected the request.', 400);
  return error;
}

function isMissingEvent(error) {
  const status = Number(error?.response?.status || error?.status);
  return status === 404 || status === 410;
}

function pickupNotice(claim, prefix) {
  return `${prefix} Pickup: ${formatPickupDateTime(claim)} at ${claim.pickup_location}.`;
}

function createIcs(claim) {
  const start = new Date(claim.pickup_at);
  const end = new Date(start.getTime() + PICKUP_DURATION_MINUTES * 60_000);
  const stamp = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const escape = (value) => String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n')
    .replace(/,/g, '\\,').replace(/;/g, '\\;');
  const title = `Item pickup – Claim #${claim.id}`;
  const description = `Claim reference: #${claim.id}\nPickup location: ${claim.pickup_location}`;
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//BukSU Lost and Found//Pickup//EN',
    'BEGIN:VEVENT',
    `UID:${deterministicEventId(claim.id)}@buksu-lost-and-found`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${escape(title)}`,
    `DESCRIPTION:${escape(description)}`,
    `LOCATION:${escape(claim.pickup_location)}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

module.exports = {
  createGoogleCalendar,
  deterministicEventId,
  validatePickup,
  zonedDateTimeToUtc,
  buildEvent,
  createIcs,
};
