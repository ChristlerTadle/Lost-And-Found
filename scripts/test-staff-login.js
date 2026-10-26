const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { createAuthService } = require('../src/services/auth');

async function run() {
  const staff = {
    _id: 'staff-1',
    email: 'staff@example.edu',
    full_name: 'Staff Member',
    role_name: 'staff',
    status: 'active',
    password_hash: await bcrypt.hash('staff-password', 4),
  };
  const student = {
    _id: 'student-1',
    email: 'student@example.edu',
    full_name: 'Student Member',
    role_name: 'user',
    status: 'active',
    password_hash: await bcrypt.hash('student-password', 4),
  };
  const admin = {
    _id: 'admin-1',
    email: 'admin@example.edu',
    full_name: 'Admin Member',
    role_name: 'admin',
    status: 'active',
    password_hash: await bcrypt.hash('admin-password', 4),
  };
  const users = [staff, student, admin];
  const service = createAuthService({
    collection(name) {
      if (name === 'users') {
        return {
          findOne: async (filter) => users.find((user) => user.email === filter.email) || null,
          find: (filter) => ({
            sort() {
              return this;
            },
            toArray: async () => users.filter((user) => filter.role_name.$in.includes(user.role_name)
              && (!filter.status || user.status === filter.status))
              .map(({ _id, password_hash, ...user }) => ({ ...user, id: String(_id) })),
          }),
          updateOne: async (filter, update) => {
            const user = users.find((candidate) => candidate._id === filter._id
              && candidate.role_name === filter.role_name
              && candidate.status === filter.status);
            if (!user) return { matchedCount: 0 };
            Object.assign(user, update.$set);
            return { matchedCount: 1 };
          },
        };
      }
      assert.equal(name, 'password_resets');
      return {};
    },
  });

  const signedInStaff = await service.login(' STAFF@example.edu ', 'staff-password');
  assert.equal(signedInStaff.role_name, 'staff');
  assert.equal(signedInStaff.id, staff._id);
  assert.equal('password_hash' in signedInStaff, false);

  const signedInStudent = await service.login(student.email, 'student-password');
  assert.equal(signedInStudent.role_name, 'user');
  await assert.rejects(service.login(staff.email, 'wrong-password'), /Invalid credentials/);
  assert.throws(
    () => service.requireRole(signedInStudent, ['staff']),
    (error) => error.status === 403,
  );
  assert.doesNotThrow(() => service.requireRole(signedInStaff, ['staff']));
  const assignableAccounts = await service.findAccountsForStaffAssignment();
  assert.equal(assignableAccounts.length, 2);
  assert.equal(assignableAccounts.some((account) => 'password_hash' in account), false);
  await service.assignStaffRole(student._id);
  assert.equal(student.role_name, 'staff');
  await assert.rejects(service.assignStaffRole(staff._id), (error) => error.status === 404);
  await assert.rejects(service.assignStaffRole(admin._id), (error) => error.status === 404);
  console.log('Staff login and role checks passed.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
