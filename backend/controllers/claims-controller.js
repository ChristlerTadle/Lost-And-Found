
function createClaimsController({ items, googleCalendar }) {
  return {
    getClaimsMine: async (req, res) => {
      const user = req.user;
      const claims = await items.findClaimsForUser(user.id);
      return res.json({
        claims: claims.map(({
          calendar_event_id, calendar_sync_status, calendar_sync_reason, ...claim
        }) => ({
          ...claim,
          calendar_url: googleCalendar.googleCalendarUrl(claim),
        })),
      });
    },

    getClaimsCalendarIcs: async (req, res) => {
      const claim = await googleCalendar.findUserCalendarClaim(req.user.id, req.params.id);
      if (!claim) {
        const error = new Error('Pickup appointment was not found.');
        error.status = 404;
        throw error;
      }
      res.type('text/calendar; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="claim-${claim.id}-pickup.ics"`);
      return res.send(googleCalendar.createIcs(claim));
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
