const { createHash } = require('node:crypto');

const PICKUP_DURATION_MINUTES = 30;

function googleCalendarUrl(claim) {
  if (!claim?.pickup_at || !claim?.pickup_location) return '';
  const start = new Date(claim.pickup_at);
  if (Number.isNaN(start.getTime())) return '';
  const end = new Date(start.getTime() + PICKUP_DURATION_MINUTES * 60_000);
  const timeZone = claim.pickup_time_zone || 'Asia/Manila';
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `Item pickup – Claim #${claim.id}`,
    dates: `${googleDate(start)}/${googleDate(end)}`,
    details: `Claim reference: #${claim.id}\nPickup location: ${claim.pickup_location}`,
    location: claim.pickup_location,
    ctz: timeZone,
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

function formatPickupDateTime(claim) {
  if (!claim?.pickup_at) return '';
  const date = new Date(claim.pickup_at);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: claim.pickup_time_zone || 'Asia/Manila',
  }).format(date);
}

function googleDate(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function deterministicEventId(claimId) {
  return `claim${createHash('sha256').update(String(claimId)).digest('hex')}`;
}

module.exports = {
  PICKUP_DURATION_MINUTES,
  googleCalendarUrl,
  formatPickupDateTime,
  deterministicEventId,
};
