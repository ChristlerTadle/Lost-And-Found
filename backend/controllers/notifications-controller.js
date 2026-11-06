
function createNotificationsController({ notifications }) {
  return {
    getNotifications: async (req, res) => {
      const user = req.user;
      return res.json({ notifications: await notifications.findForUser(user.id) });
    },

    patchNotificationsReadall: async (req, res) => {
      const user = req.user;
      await notifications.markAllRead(user.id);
      return res.json({ message: 'Notifications marked read.' });
    },

    patchNotificationsByIdRead: async (req, res) => {
      const user = req.user;
      await notifications.markRead(user.id, req.params.id);
      return res.json({ message: 'Notification marked read.' });
    },
  };
}

module.exports = { createNotificationsController };
