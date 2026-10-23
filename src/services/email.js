const nodemailer = require('nodemailer');

function createEmailService(config) {
  return {
    async sendPasswordReset(to, resetUrl) {
      if (!config.host || !config.from) {
        throw new Error('Password reset email is not configured. Set SMTP_HOST and SMTP_FROM in .env.');
      }
      if (Boolean(config.user) !== Boolean(config.password)) {
        throw new Error('SMTP_USER and SMTP_PASSWORD must either both be set or both be empty.');
      }

      const transporter = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        requireTLS: !config.secure,
        ...(config.user ? { auth: { user: config.user, pass: config.password } } : {}),
      });
      await transporter.sendMail({
        from: config.from,
        to,
        subject: 'Reset your BukSU Lost & Found password',
        text: `Use this link to reset your password. It expires in one hour:\n\n${resetUrl}\n\nIf you did not request a reset, you can ignore this email.`,
        html: `<p>Use the link below to reset your password. It expires in one hour.</p><p><a href="${escapeHtml(resetUrl)}">Reset your password</a></p><p>If you did not request a reset, you can ignore this email.</p>`,
      });
    },
  };
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
