const { randomUUID } = require('node:crypto');

function createNotificationService(database) {
  const notifications = database.collection('notifications');
  const users = database.collection('users');
  const rolePermissions = database.collection('role_permissions');

  return {
    async create(userId, { type, title, message, href }, options = {}) {
      const user = await users.findOne(
        { _id: String(userId) },
        { projection: { role_name: 1 }, ...(options.session ? { session: options.session } : {}) },
      );
      if (!user || !['user', 'staff', 'admin'].includes(user.role_name)) return null;
      if (user.role_name !== 'admin') {
        const enabled = await rolePermissions.findOne(
          { role: user.role_name, permission_key: 'receive_notifications', enabled: true },
          options.session ? { projection: { _id: 1 }, session: options.session } : { projection: { _id: 1 } },
        );
        if (!enabled) return null;
      }
      const notification = {
        _id: randomUUID(),
        user_id: String(userId),
        type,
        title,
        message,
        href,
        read_at: null,
        created_at: new Date().toISOString(),
      };
      await notifications.insertOne(notification, options.session ? { session: options.session } : undefined);
      return { ...notification, id: notification._id };
    },

    async findForUser(userId, limit = 100) {
      const documents = await notifications.find({ user_id: String(userId) })
        .sort({ created_at: -1 })
        .limit(limit)
        .toArray();
      return documents.map(({ _id, ...notification }) => ({ ...notification, id: String(_id) }));
    },

    async countUnread(userId) {
      return notifications.countDocuments({ user_id: String(userId), read_at: null });
    },

    async markRead(userId, notificationId) {
      await notifications.updateOne(
        { _id: notificationId, user_id: String(userId), read_at: null },
        { $set: { read_at: new Date().toISOString() } },
      );
    },

    async markAllRead(userId) {
      await notifications.updateMany(
        { user_id: String(userId), read_at: null },
        { $set: { read_at: new Date().toISOString() } },
      );
    },
  };
}

module.exports = { createNotificationService };
