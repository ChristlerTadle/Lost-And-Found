
const { saveSession } = require('../middlewares/session-auth');

function createProfileController({ auth, items }) {
  return {
    getProfile: async (req, res) => {
      const user = req.user;
      const permissions = req.rolePermissions || [];
      const [reports, claims] = await Promise.all([
        permissions.includes('view_my_reports') ? items.findForUser(user.id) : [],
        permissions.includes('view_claim_status') ? items.findClaimsForUser(user.id) : [],
      ]);
      return res.json({ user, reports, claims });
    },

    patchProfile: async (req, res) => {
      const user = req.user;
      const updatedUser = await auth.updateProfile(user.id, req.body);
      req.session.user = updatedUser;
      await saveSession(req);
      return res.json({ user: updatedUser });
    },
  };
}

module.exports = { createProfileController };
