const { randomUUID } = require('node:crypto');

function createNotificationService(database) {
  const notifications = database.collection('notifications');

  return {
    async create(userId, { type, title, message, href }) {
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
      await notifications.insertOne(notification);
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
