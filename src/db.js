const { MongoClient } = require('mongodb');
const config = require('./config');

let client;
let database;

async function connectDatabase() {
  if (database) return database;
  client = new MongoClient(config.mongodbUri);
  await client.connect();
  database = client.db(config.mongodbDatabase);

  await Promise.all([
    database.collection('users').createIndex({ email: 1 }, { unique: true }),
    database.collection('users').createIndex({ google_sub: 1 }, { unique: true, sparse: true }),
    database.collection('users').createIndex(
      { student_id: 1 },
      { unique: true, partialFilterExpression: { student_id: { $type: 'string' } } },
    ),
    database.collection('password_resets').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    database.collection('password_resets').createIndex({ user_id: 1 }),
    database.collection('lost_items').createIndex({ status: 1, date_lost: -1 }),
    database.collection('lost_items').createIndex({ user_id: 1, created_at: -1 }),
    database.collection('item_claims').createIndex({ item_id: 1, user_id: 1 }, { unique: true }),
    database.collection('item_claims').createIndex({ user_id: 1, created_at: -1 }),
    database.collection('notifications').createIndex({ user_id: 1, created_at: -1 }),
    database.collection('notifications').createIndex({ user_id: 1, read_at: 1 }),
  ]);
  return database;
}

async function closeDatabase() {
  if (client) await client.close();
  client = undefined;
  database = undefined;
}

module.exports = { connectDatabase, closeDatabase };
