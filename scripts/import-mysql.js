const mysql = require('mysql2/promise');
const { MongoClient } = require('mongodb');
const { createInterface } = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../src/config');
const projectRoot = path.resolve(__dirname, '..');

async function main() {
  const prompt = createInterface({ input: stdin, output: stdout });
  const answer = await prompt.question(
    `This imports MySQL ${config.mysqlSource.database} into MongoDB ${config.mongodbDatabase} using matching IDs. Type IMPORT to continue: `,
  );
  prompt.close();
  if (answer !== 'IMPORT') {
    console.log('Import cancelled. MySQL was not changed.');
    return;
  }

  const source = await mysql.createConnection({ ...config.mysqlSource, dateStrings: true });
  const client = new MongoClient(config.mongodbUri);
  try {
    await client.connect();
    const database = client.db(config.mongodbDatabase);
    await createIndexes(database);

    const [userRows] = await source.query(
      'SELECT u.*, r.role_name FROM users u LEFT JOIN roles r ON r.id = u.role_id',
    );
    const [itemRows] = await source.query('SELECT * FROM lost_items');
    const userCount = await importRows(database.collection('users'), userRows, (row) => {
      const { id, role_id, ...fields } = row;
      return {
        ...fields,
        _id: String(id),
        student_id: row.student_id || null,
        employee_id: row.employee_id || null,
        role_name: row.role_name || 'user',
      };
    });
    const itemCount = await importRows(database.collection('lost_items'), itemRows, (row) => {
      const { id, ...fields } = row;
      const itemType = ['lost', 'found'].includes(row.item_type) ? row.item_type : 'lost';
      return {
        ...fields,
        _id: String(id),
        user_id: String(row.user_id),
        item_type: itemType,
        status: row.status === 'cancelled' ? 'cancelled' : itemType,
        image_path: findImagePath(String(id), row.image_path),
      };
    });

    let claimCount = 0;
    try {
      const [claimRows] = await source.query('SELECT * FROM item_claims');
      claimCount = await importRows(database.collection('item_claims'), claimRows, (row) => {
        const { id, ...fields } = row;
        return { ...fields, _id: String(id), item_id: String(row.item_id), user_id: String(row.user_id) };
      });
    } catch (error) {
      if (error.code !== 'ER_NO_SUCH_TABLE') throw error;
      console.log('No item_claims table exists in MySQL; skipping claims.');
    }

    console.log(`Imported or updated ${userCount} users, ${itemCount} reports, and ${claimCount} claims.`);
    console.log('The MySQL source was not modified or deleted.');
  } finally {
    await source.end();
    await client.close();
  }
}

async function importRows(collection, rows, mapRow) {
  if (!rows.length) return 0;
  const operations = rows.map((row) => {
    const document = mapRow(row);
    return { replaceOne: { filter: { _id: document._id }, replacement: document, upsert: true } };
  });
  await collection.bulkWrite(operations, { ordered: false });
  return rows.length;
}

async function createIndexes(database) {
  await Promise.all([
    database.collection('users').createIndex({ email: 1 }, { unique: true }),
    database.collection('users').createIndex(
      { student_id: 1 },
      { unique: true, partialFilterExpression: { student_id: { $type: 'string' } } },
    ),
    database.collection('lost_items').createIndex({ status: 1, date_lost: -1 }),
    database.collection('lost_items').createIndex({ user_id: 1, created_at: -1 }),
    database.collection('item_claims').createIndex({ item_id: 1, user_id: 1 }, { unique: true }),
    database.collection('item_claims').createIndex({ user_id: 1, created_at: -1 }),
  ]);
}

function findImagePath(reportId, storedPath) {
  const candidates = [];
  if (storedPath) candidates.push(String(storedPath).replaceAll('\\', '/').replace(/^\/+/, ''));
  for (const extension of ['jpg', 'jpeg', 'png', 'webp']) {
    candidates.push(`uploads/lost/${reportId}.${extension}`);
  }

  const uploadRoot = path.resolve(projectRoot, 'uploads', 'lost');
  for (const candidate of candidates) {
    const absolutePath = path.resolve(projectRoot, candidate);
    const relativeToUploads = path.relative(uploadRoot, absolutePath);
    if (relativeToUploads.startsWith('..') || path.isAbsolute(relativeToUploads)) continue;
    if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
      return path.relative(projectRoot, absolutePath).split(path.sep).join('/');
    }
  }
  return null;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Import failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { findImagePath };
