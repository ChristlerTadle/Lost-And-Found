
function createClaimsController({ items }) {
  return {
    getClaimsMine: async (req, res) => {
      const user = req.user;
      return res.json({ claims: await items.findClaimsForUser(user.id) });
    },

    getClaimsAvailableById: async (req, res) => {
      const user = req.user;
      return res.json({ item: await items.findAvailable(req.params.id, user.id) });
    },

    postClaims: async (req, res) => {
      const user = req.user;
      const claim = await items.createClaim(user.id, req.body);
      return res.status(201).json({ claim });
    },
  };
}

module.exports = { createClaimsController };
