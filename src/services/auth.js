const bcrypt = require('bcryptjs');
const { createHash, randomBytes, randomUUID } = require('node:crypto');

function toUser(document) {
  if (!document) return null;
  const { _id, password_hash, google_sub, ...user } = document;
  return { ...user, id: String(_id) };
}

function createAuthService(database) {
  const users = database.collection('users');
  const passwordResets = database.collection('password_resets');

  return {
    async register(input) {
      return createPasswordAccount(users, input);
    },

    async createAdminUser(input) {
      return createPasswordAccount(users, input);
    },

    async login(emailInput, password) {
      const email = String(emailInput || '').trim().toLowerCase();
      const user = await users.findOne({ email });
      if (!user || user.status !== 'active' || !user.password_hash
        || !(await bcrypt.compare(String(password || ''), user.password_hash))) {
        throw new Error('Invalid credentials.');
      }
      return toUser(user);
    },

    async findActiveSessionUser(userId) {
      const user = await users.findOne({ _id: String(userId), status: 'active' });
      return toUser(user);
    },

    async getAdminUserSummary() {
      const [totalUsers, activeUsers] = await Promise.all([
        users.countDocuments({}),
        users.countDocuments({ status: 'active' }),
      ]);
      return { totalUsers, activeUsers };
    },

    async authenticateGoogle(profile) {
      const subject = String(profile.sub || '');
      const email = String(profile.email || '').trim().toLowerCase();
      const fullName = String(profile.name || '').trim();
      if (!subject || !/^\S+@\S+\.\S+$/.test(email) || profile.emailVerified !== true || !fullName) {
        throw new Error('Google did not provide a verified account profile.');
      }

      const existingGoogleUser = await users.findOne({ google_sub: subject });
      if (existingGoogleUser) {
        if (existingGoogleUser.status !== 'active') throw new Error('This account is not active.');
        return toUser(existingGoogleUser);
      }

      const existingEmailUser = await users.findOne({ email });
      if (existingEmailUser) {
        if (existingEmailUser.status !== 'active') throw new Error('This account is not active.');
        if (existingEmailUser.google_sub && existingEmailUser.google_sub !== subject) {
          throw new Error('This email is linked to a different Google account.');
        }
        try {
          await users.updateOne(
            { _id: existingEmailUser._id, email, google_sub: { $in: [null, subject] } },
            { $set: { google_sub: subject, updated_at: new Date().toISOString() } },
          );
        } catch (error) {
          if (error.code !== 11000) throw error;
        }
        const linkedUser = await users.findOne({ google_sub: subject });
        if (linkedUser?.status === 'active' && linkedUser.email === email) return toUser(linkedUser);
        throw new Error('This email could not be linked to the Google account.');
      }

      const now = new Date().toISOString();
      const user = {
        _id: randomUUID(),
        email,
        google_sub: subject,
        password_hash: null,
        full_name: fullName,
        student_id: null,
        employee_id: null,
        phone: null,
        role_name: 'user',
        status: 'active',
        created_at: now,
        updated_at: now,
      };
      try {
        await users.insertOne(user);
        return toUser(user);
      } catch (error) {
        if (error.code !== 11000) throw error;
        const racedUser = await users.findOne({ google_sub: subject });
        if (racedUser?.status === 'active' && racedUser.email === email) return toUser(racedUser);
        throw new Error('An account with this email already exists. Sign in with its linked Google account.');
      }
    },

    async findAccountsForStaffAssignment() {
      const accounts = await users.find(
        { role_name: { $in: ['user', 'staff'] } },
        { projection: { full_name: 1, email: 1, role_name: 1, status: 1, employee_id: 1, student_id: 1 } },
      ).sort({ full_name: 1 }).toArray();
      return accounts.map(({ _id, ...account }) => ({ ...account, id: String(_id) }));
    },

    async findAdminEditableUser(userId) {
      const user = await users.findOne({
        _id: String(userId),
        role_name: { $in: ['user', 'staff'] },
        status: 'active',
      }, {
        projection: { full_name: 1, email: 1, student_id: 1, employee_id: 1, phone: 1, role_name: 1 },
      });
      if (!user) {
        const error = new Error('Active user account was not found.');
        error.status = 404;
        throw error;
      }
      return toUser(user);
    },

    async updateUserByAdmin(userId, input) {
      const email = String(input.email || '').trim().toLowerCase();
      const fullName = String(input.full_name || '').trim();
      if (!/^\S+@\S+\.\S+$/.test(email) || !fullName) {
        const error = new Error('Enter a valid name and email address.');
        error.status = 400;
        throw error;
      }

      try {
        const result = await users.updateOne(
          { _id: String(userId), role_name: { $in: ['user', 'staff'] }, status: 'active' },
          { $set: {
            full_name: fullName,
            email,
            student_id: nullable(input.student_id),
            phone: nullable(input.phone),
            updated_at: new Date().toISOString(),
          } },
        );
        if (!result.matchedCount) {
          const error = new Error('Active user account was not found.');
          error.status = 404;
          throw error;
        }
      } catch (error) {
        if (error.code === 11000) {
          const duplicateError = new Error('An account with that email or student ID already exists.');
          duplicateError.status = 400;
          throw duplicateError;
        }
        throw error;
      }
    },

    async assignStaffRole(userId) {
      const result = await users.updateOne(
        { _id: String(userId), role_name: 'user', status: 'active' },
        { $set: { role_name: 'staff', updated_at: new Date().toISOString() } },
      );
      if (!result.matchedCount) {
        const error = new Error('Only active user accounts can be assigned staff access.');
        error.status = 404;
        throw error;
      }
    },

    async revertStaffRole(userId) {
      const result = await users.updateOne(
        { _id: String(userId), role_name: 'staff', status: 'active' },
        { $set: { role_name: 'user', updated_at: new Date().toISOString() } },
      );
      if (!result.matchedCount) {
        const error = new Error('Only active staff accounts can be changed back to user access.');
        error.status = 404;
        throw error;
      }
    },

    async setUserAccountStatus(userId, status) {
      if (!['active', 'disabled'].includes(status)) throw new Error('Choose a valid account status.');
      const filter = {
        _id: String(userId),
        role_name: { $in: ['user', 'staff'] },
        status: status === 'disabled' ? 'active' : 'disabled',
      };
      const result = await users.updateOne(
        filter,
        { $set: { status, updated_at: new Date().toISOString() } },
      );
      if (!result.matchedCount) {
        const error = new Error('The account status could not be changed. Refresh the account list and try again.');
        error.status = 404;
        throw error;
      }
    },

    async requestPasswordReset(emailInput, sendEmail) {
      const email = String(emailInput || '').trim().toLowerCase();
      const user = await users.findOne({ email, status: 'active' });
      if (!user) return;

      const token = randomBytes(32).toString('base64url');
      const tokenHash = hashToken(token);
      const now = new Date();
      await passwordResets.deleteMany({ user_id: user._id });
      await passwordResets.insertOne({
        user_id: user._id,
        token_hash: tokenHash,
        created_at: now,
        expires_at: new Date(now.getTime() + 60 * 60 * 1000),
      });
      try {
        await sendEmail(user.email, token);
      } catch (error) {
        await passwordResets.deleteOne({ user_id: user._id, token_hash: tokenHash });
        throw error;
      }
    },

    async isPasswordResetTokenValid(token) {
      if (!token) return false;
      const reset = await passwordResets.findOne({
        token_hash: hashToken(token),
        expires_at: { $gt: new Date() },
        consumed_at: { $exists: false },
      });
      return Boolean(reset);
    },

    async resetPassword(token, password, confirmation) {
      if (String(password || '').length < 8) throw new Error('Password must be at least 8 characters long.');
      if (password !== confirmation) throw new Error('The passwords do not match.');
      if (!token) throw new Error('This password reset link is invalid or has expired. Request a new one.');

      const now = new Date();
      const reset = await passwordResets.findOneAndUpdate(
        { token_hash: hashToken(token), expires_at: { $gt: now }, consumed_at: { $exists: false } },
        { $set: { consumed_at: now } },
        { returnDocument: 'after' },
      );
      if (!reset) throw new Error('This password reset link is invalid or has expired. Request a new one.');

      const result = await users.updateOne(
        { _id: reset.user_id, status: 'active' },
        { $set: { password_hash: await bcrypt.hash(password, 12), updated_at: now.toISOString() } },
      );
      await passwordResets.deleteMany({ user_id: reset.user_id });
      if (!result.matchedCount) throw new Error('This password reset link is invalid or has expired. Request a new one.');
    },

    async updateProfile(userId, input) {
      const fullName = String(input.full_name || '').trim();
      if (!fullName) throw new Error('Full name is required.');
      await users.updateOne(
        { _id: userId, status: 'active' },
        { $set: {
          full_name: fullName,
          phone: nullable(input.phone),
          updated_at: new Date().toISOString(),
        } },
      );
      const updated = await users.findOne({ _id: userId });
      if (!updated) throw new Error('User was not found.');
      return toUser(updated);
    },

    requireRole(user, roles) {
      if (!roles.includes(user?.role_name)) {
        const error = new Error('You do not have permission to perform this action.');
        error.status = 403;
        throw error;
      }
    },
  };
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function nullable(value) {
  const text = String(value || '').trim();
  return text || null;
}

async function createPasswordAccount(users, input) {
  const email = String(input.email || '').trim().toLowerCase();
  const password = String(input.password || '');
  const fullName = String(input.full_name || '').trim();
  if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 8 || !fullName) {
    const error = new Error('Enter a valid name, email, and password of at least 8 characters.');
    error.status = 400;
    throw error;
  }

  const now = new Date().toISOString();
  const user = {
    _id: randomUUID(),
    email,
    password_hash: await bcrypt.hash(password, 12),
    full_name: fullName,
    student_id: nullable(input.student_id),
    employee_id: null,
    phone: nullable(input.phone),
    role_name: 'user',
    status: 'active',
    created_at: now,
    updated_at: now,
  };
  try {
    await users.insertOne(user);
  } catch (error) {
    if (error.code === 11000) {
      const duplicateError = new Error('An account with that email or student ID already exists.');
      duplicateError.status = 400;
      throw duplicateError;
    }
    throw error;
  }
  return toUser(user);
}

module.exports = { createAuthService };
