const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const port = Number(process.env.PORT || 3000);

module.exports = {
  port,
  appBaseUrl: process.env.APP_BASE_URL || `http://localhost:${port}`,
  sessionSecret: process.env.SESSION_SECRET || 'replace-this-session-secret-before-deployment',
  mongodbUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017',
  mongodbDatabase: process.env.MONGODB_DATABASE || 'lost_and_found',
  googleOAuth: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI || new URL('/auth/google/callback', process.env.APP_BASE_URL || `http://localhost:${port}`).toString(),
  },
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    from: process.env.SMTP_FROM || '',
  },
  mysqlSource: {
    host: process.env.MYSQL_SOURCE_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_SOURCE_PORT || 3306),
    database: process.env.MYSQL_SOURCE_DATABASE || 'lost_and_found',
    user: process.env.MYSQL_SOURCE_USER || 'root',
    password: process.env.MYSQL_SOURCE_PASSWORD || '',
  },
};
