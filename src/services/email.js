const nodemailer = require('nodemailer');
const SMTP_TIMEOUT_MS = 10_000;

function createEmailService(getIntegration, mailer = nodemailer, callIntegration = runDirectly) {
  async function getTransport(override) {
    const integration = override ? null : await getIntegration('smtp');
    if (!override && !integration.active) return null;
    const config = override || integration.settings;
    if (Boolean(config.user) !== Boolean(config.password)) {
      throw new Error('SMTP username and password must either both be set or both be empty.');
    }
    const transporter = mailer.createTransport({
      host: config.host,
      port: Number(config.port),
      secure: config.secure,
      requireTLS: !config.secure,
      connectionTimeout: SMTP_TIMEOUT_MS,
      greetingTimeout: SMTP_TIMEOUT_MS,
      socketTimeout: SMTP_TIMEOUT_MS,
      ...(config.user ? { auth: { user: config.user, pass: config.password } } : {}),
    });
    return { transporter, config };
  }

  return {
    async sendPasswordReset(to, resetUrl, auditContext) {
      const integration = await getIntegration('smtp');
      if (!integration.active) return false;
      return callIntegration('smtp', async () => {
        const { transporter, config } = await getTransport(integration.settings);
        await transporter.sendMail({
          from: formatSender(config.sender_name, config.sender_email),
          to,
          subject: 'Reset your BukSU Lost & Found password',
          text: `Use this link to reset your password. It expires in one hour:\n\n${resetUrl}\n\nIf you did not request a reset, you can ignore this email.`,
          html: `<p>Use the link below to reset your password. It expires in one hour.</p><p><a href="${escapeHtml(resetUrl)}">Reset your password</a></p><p>If you did not request a reset, you can ignore this email.</p>`,
        });
        return true;
      }, auditContext);
    },

    async sendPickupNotification(to, pickup, auditContext) {
      const integration = await getIntegration('smtp');
      if (!integration.active) return false;
      const cancelled = pickup.status === 'cancelled';
      const pickupDate = new Intl.DateTimeFormat('en', {
        dateStyle: 'full',
        timeStyle: 'short',
        timeZone: pickup.timeZone || 'Asia/Manila',
      }).format(new Date(pickup.pickupAt));
      const subject = cancelled
        ? `Pickup cancelled for Claim #${pickup.claimId}`
        : pickup.status === 'rescheduled'
          ? `Pickup rescheduled for Claim #${pickup.claimId}`
          : `Pickup scheduled for Claim #${pickup.claimId}`;
      const text = cancelled
        ? `The scheduled pickup for Claim #${pickup.claimId} has been cancelled.\n\nPickup: ${pickupDate}\nLocation: ${pickup.pickupLocation}`
        : `${pickup.status === 'rescheduled' ? 'The pickup for your approved claim' : 'Your claim'} #${pickup.claimId} ${pickup.status === 'rescheduled' ? 'has been rescheduled.' : 'was approved.'}\n\nPickup: ${pickupDate}\nLocation: ${pickup.pickupLocation}\n\nAdd to Google Calendar: ${pickup.calendarUrl}`;
      const html = cancelled
        ? `<p>The scheduled pickup for Claim #${escapeHtml(pickup.claimId)} has been cancelled.</p><p><strong>Pickup:</strong> ${escapeHtml(pickupDate)}<br><strong>Location:</strong> ${escapeHtml(pickup.pickupLocation)}</p>`
        : `<p>${pickup.status === 'rescheduled' ? 'The pickup for your approved claim' : 'Your claim'} #${escapeHtml(pickup.claimId)} ${pickup.status === 'rescheduled' ? 'has been rescheduled.' : 'was approved.'}</p><p><strong>Pickup:</strong> ${escapeHtml(pickupDate)}<br><strong>Location:</strong> ${escapeHtml(pickup.pickupLocation)}</p><p><a href="${escapeHtml(pickup.calendarUrl)}">Add to Google Calendar</a></p>`;
      return callIntegration('smtp', async () => {
        const { transporter, config } = await getTransport(integration.settings);
        await transporter.sendMail({
          from: formatSender(config.sender_name, config.sender_email),
          to,
          subject,
          text,
          html,
        });
        return true;
      }, auditContext);
    },

    async testConnection(settings, auditContext) {
      const integration = settings ? null : await getIntegration('smtp');
      if (!settings && !integration.active) return false;
      const config = settings || integration.settings;
      return callIntegration('smtp', async () => {
        const transport = await getTransport(config);
        await transport.transporter.verify();
        return true;
      }, auditContext);
    },
  };
}

function runDirectly(_integrationId, operation) {
  return operation({ signal: new AbortController().signal });
}

function formatSender(name, email) {
  if (!name) return email;
  return `"${name.replace(/["\\]/g, '\\$&')}" <${email}>`;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

module.exports = { createEmailService };
