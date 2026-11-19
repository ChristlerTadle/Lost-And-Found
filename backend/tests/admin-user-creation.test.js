const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createAuthService } = require('../../src/services/auth');

function createMemoryUsers() {
  const rows = [];
  return {
    rows,
    async insertOne(user) {
      rows.push(user);
      return { insertedId: user._id };
    },
    async updateOne(filter, update) {
      const user = rows.find(({ _id }) => _id === filter._id);
      if (!user) return { matchedCount: 0 };
      Object.assign(user, update.$set);
      return { matchedCount: 1 };
    },
    async findOne(filter) {
      return rows.find(({ _id }) => _id === filter._id) || null;
    },
    async deleteOne(filter) {
      const index = rows.findIndex(({ _id }) => _id === filter._id);
      if (index < 0) return { deletedCount: 0 };
      rows.splice(index, 1);
      return { deletedCount: 1 };
    },
  };
}

test('admin account creation permits only User and Staff and persists the selected role', async () => {
  const users = createMemoryUsers();
  const auth = createAuthService({
    collection(name) {
      return name === 'users' ? users : {};
    },
  });
  const input = {
    full_name: 'New Staff',
    email: 'new-staff@example.test',
    password: 'secure-password',
  };

  const staff = await auth.createAdminUser(input, { roleName: 'staff' });
  assert.equal(staff.role_name, 'staff');
  assert.equal(staff.status, 'active');
  assert.equal('password_hash' in staff, false);
  assert.equal(users.rows[0].role_name, 'staff');
  assert.notEqual(users.rows[0].password_hash, input.password);

  await assert.rejects(
    auth.createAdminUser(input, { roleName: 'admin' }),
    { status: 400 },
  );
  assert.equal(users.rows.length, 1);
  assert.equal(await auth.deleteAdminUser(staff.id), true);
  assert.equal(users.rows.length, 0);
});

test('phone numbers reject letters during registration, profile updates, and admin edits', async () => {
  const users = createMemoryUsers();
  const auth = createAuthService({
    collection(name) {
      return name === 'users' ? users : {};
    },
  });
  const input = {
    full_name: 'New User',
    email: 'new-user@example.test',
    password: 'secure-password',
    phone: '5551234abc',
  };

  await assert.rejects(auth.register(input), { status: 400, message: 'Phone number must contain digits only.' });
  assert.equal(users.rows.length, 0);

  const user = await auth.register({ ...input, phone: '5551234' });
  await assert.rejects(auth.updateProfile(user.id, {
    full_name: user.full_name,
    phone: '5551234abc',
  }), { status: 400, message: 'Phone number must contain digits only.' });
  await assert.rejects(auth.updateUserByAdmin(user.id, {
    full_name: user.full_name,
    email: user.email,
    phone: '5551234abc',
  }), { status: 400, message: 'Phone number must contain digits only.' });

  assert.equal(users.rows[0].phone, '5551234');
});
