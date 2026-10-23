const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { createAuthService } = require('../src/services/auth');

function matches(document, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = document[key];
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      if ('$gt' in expected) return actual > expected.$gt;
      if ('$exists' in expected) return (key in document) === expected.$exists;
    }
    return actual === expected;
  });
}

async function run() {
  const user = {
    _id: 'user-1',
    email: 'user@example.edu',
    status: 'active',
    password_hash: await bcrypt.hash('old-password', 4),
  };
  const users = [user];
  const resets = [];
  const database = {
    collection(name) {
      if (name === 'users') {
        return {
          findOne: async (filter) => users.find((document) => matches(document, filter)) || null,
          updateOne: async (filter, update) => {
            const document = users.find((candidate) => matches(candidate, filter));
            if (!document) return { matchedCount: 0 };
            Object.assign(document, update.$set);
            return { matchedCount: 1 };
          },
        };
      }
      assert.equal(name, 'password_resets');
      return {
        findOne: async (filter) => resets.find((document) => matches(document, filter)) || null,
        findOneAndUpdate: async (filter, update) => {
          const document = resets.find((candidate) => matches(candidate, filter));
          if (!document) return null;
          Object.assign(document, update.$set);
          return document;
        },
        insertOne: async (document) => resets.push(document),
        deleteOne: async (filter) => {
          const index = resets.findIndex((document) => matches(document, filter));
          if (index !== -1) resets.splice(index, 1);
        },
        deleteMany: async (filter) => {
          for (let index = resets.length - 1; index >= 0; index -= 1) {
            if (matches(resets[index], filter)) resets.splice(index, 1);
          }
        },
      };
    },
  };
  const auth = createAuthService(database);
  let token;

  await auth.requestPasswordReset('missing@example.edu', async () => {
    assert.fail('Must not send email for an unknown account.');
  });
  assert.equal(resets.length, 0);

  await auth.requestPasswordReset(' USER@example.edu ', async (address, value) => {
    assert.equal(address, user.email);
    token = value;
  });
  assert.match(token, /^[\w-]{43}$/);
  assert.notEqual(resets[0].token_hash, token);
  assert.equal(await auth.isPasswordResetTokenValid(token), true);
  assert.equal(await auth.isPasswordResetTokenValid('invalid-token'), false);
  const expiredToken = token;
  resets[0].expires_at = new Date(Date.now() - 1000);
  assert.equal(await auth.isPasswordResetTokenValid(expiredToken), false);
  await auth.requestPasswordReset(user.email, async (_address, value) => { token = value; });
  await assert.rejects(auth.resetPassword(token, 'new-password', 'different'), /do not match/);
  await auth.resetPassword(token, 'new-password', 'new-password');
  assert.equal(await auth.isPasswordResetTokenValid(token), false);
  await assert.rejects(auth.resetPassword(token, 'another-password', 'another-password'), /invalid or has expired/);
  assert.equal((await auth.login(user.email, 'new-password')).id, user._id);
  await assert.rejects(auth.login(user.email, 'old-password'), /Invalid credentials/);

  await assert.rejects(
    auth.requestPasswordReset(user.email, async () => { throw new Error('SMTP unavailable'); }),
    /SMTP unavailable/,
  );
  assert.equal(resets.length, 0);
  console.log('Password reset service checks passed.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
