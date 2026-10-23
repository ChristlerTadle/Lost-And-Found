const assert = require('node:assert/strict');
const { createAuthService } = require('../src/services/auth');

function matches(document, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = document[key];
    if (expected && typeof expected === 'object' && '$in' in expected) {
      return expected.$in.some((value) => value === actual || (value === null && actual === undefined));
    }
    return actual === expected;
  });
}

async function run() {
  const users = [
    { _id: 'existing-user', email: 'existing@example.edu', full_name: 'Existing User', role_name: 'staff', status: 'active', password_hash: 'hash' },
  ];
  const database = {
    collection(name) {
      if (name === 'password_resets') return {};
      assert.equal(name, 'users');
      return {
        findOne: async (filter) => users.find((user) => matches(user, filter)) || null,
        updateOne: async (filter, update) => {
          const user = users.find((candidate) => matches(candidate, filter));
          if (!user) return { matchedCount: 0 };
          Object.assign(user, update.$set);
          return { matchedCount: 1 };
        },
        insertOne: async (user) => {
          if (users.some((candidate) => candidate.email === user.email || candidate.google_sub === user.google_sub)) {
            const error = new Error('Duplicate key');
            error.code = 11000;
            throw error;
          }
          users.push(user);
        },
      };
    },
  };
  const auth = createAuthService(database);

  await assert.rejects(
    auth.authenticateGoogle({ sub: 'bad', email: 'unverified@example.edu', emailVerified: false, name: 'Unverified' }),
    /verified account profile/,
  );

  const linked = await auth.authenticateGoogle({
    sub: 'google-existing',
    email: 'existing@example.edu',
    emailVerified: true,
    name: 'Google Name',
  });
  assert.equal(linked.id, 'existing-user');
  assert.equal(linked.role_name, 'staff');
  assert.equal(users[0].google_sub, 'google-existing');
  assert.equal('google_sub' in linked, false);

  const created = await auth.authenticateGoogle({
    sub: 'google-new',
    email: 'new@example.edu',
    emailVerified: true,
    name: 'New Student',
  });
  assert.ok(created.id);
  assert.equal(created.role_name, 'user');
  assert.equal(created.student_id, null);
  assert.equal('google_sub' in created, false);
  assert.equal((await auth.authenticateGoogle({
    sub: 'google-new',
    email: 'new@example.edu',
    emailVerified: true,
    name: 'New Student',
  })).id, created.id);
  await assert.rejects(auth.login('new@example.edu', 'anything'), /Invalid credentials/);

  console.log('Google auth service checks passed.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
