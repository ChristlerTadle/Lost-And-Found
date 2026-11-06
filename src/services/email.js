const nodemailer = require('nodemailer');

function createEmailService(getIntegration, mailer = nodemailer) {
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
      ...(config.user ? { auth: { user: config.user, pass: config.password } } : {}),
    });
    return { transporter, config };
  }

  return {
    async sendPasswordReset(to, resetUrl) {
      const transport = await getTransport();
      if (!transport) return false;
      const { transporter, config } = transport;
      try {
        await transporter.sendMail({
          from: formatSender(config.sender_name, config.sender_email),
          to,
          subject: 'Reset your BukSU Lost & Found password',
          text: `Use this link to reset your password. It expires in one hour:\n\n${resetUrl}\n\nIf you did not request a reset, you can ignore this email.`,
          html: `<p>Use the link below to reset your password. It expires in one hour.</p><p><a href="${escapeHtml(resetUrl)}">Reset your password</a></p><p>If you did not request a reset, you can ignore this email.</p>`,
        });
        return true;
      } catch {
        const error = new Error('Password reset email could not be sent.');
        error.status = 503;
        throw error;
      }
    },

    async testConnection(settings) {
      const transport = settings ? await getTransport(settings) : await getTransport();
      if (!transport) {
        const error = new Error('Email (SMTP) is disabled or not configured.');
        error.status = 400;
        throw error;
      }
      await transport.transporter.verify();
      return true;
    },
  };
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
