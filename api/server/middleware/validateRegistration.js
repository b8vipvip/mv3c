const { getSiteSettings } = require('~/server/services/Config/mv3cSettings');

async function validateRegistration(req, res, next) {
  try {
    // Explicit invitations retain their normal LibreChat behavior.
    if (req.invite) return next();
    const site = await getSiteSettings();
    if (site.registrationEnabled) return next();
    return res.status(403).json({ message: 'Registration is disabled by mv3c Admin.' });
  } catch (error) {
    // Fail closed if the database is unavailable.
    return next(error);
  }
}

module.exports = validateRegistration;
