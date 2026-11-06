const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

module.exports = {
  sessionSecret: process.env.SESSION_SECRET || 'replace-this-session-secret-before-deployment',
  mongodbUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017',
  mongodbDatabase: process.env.MONGODB_DATABASE || 'lost_and_found',
  integrationEncryptionKey: process.env.INTEGRATION_ENCRYPTION_KEY || '',
};
