const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');
const { connectDatabase, closeDatabase } = require('../src/db');

async function seedAdmin() {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const fullName = String(process.env.ADMIN_FULL_NAME || '').trim();
  const password = String(process.env.ADMIN_PASSWORD || '');
  if (!/^\S+@\S+\.\S+$/.test(email) || !fullName || password.length < 12) {
    throw new Error('Set ADMIN_EMAIL, ADMIN_FULL_NAME, and an ADMIN_PASSWORD of at least 12 characters.');
  }

  const database = await connectDatabase();
  const users = database.collection('users');
  const existing = await users.findOne({ email });
  if (existing) {
    if (existing.role_name === 'admin' && existing.status === 'active') {
      console.log('An active admin account already exists for ADMIN_EMAIL.');
      return;
    }
    throw new Error('ADMIN_EMAIL already belongs to a non-admin or disabled account; no account was changed.');
  }

  const now = new Date().toISOString();
  await users.insertOne({
    _id: randomUUID(),
    email,
    password_hash: await bcrypt.hash(password, 12),
    full_name: fullName,
    student_id: null,
    employee_id: null,
    phone: null,
    role_name: 'admin',
    status: 'active',
    created_at: now,
    updated_at: now,
  });
  console.log('Created the active admin account specified by ADMIN_EMAIL.');
}

seedAdmin()
  .catch((error) => {
    console.error('Unable to seed admin account:', error.message);
    process.exitCode = 1;
  })
  .finally(closeDatabase);
