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
