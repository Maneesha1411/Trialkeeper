const authorizeRoles = (...allowedRoles) => {
  if (
    allowedRoles.length === 0 ||
    allowedRoles.some(
      (role) => typeof role !== "string" || !role.trim()
    )
  ) {
    throw new TypeError("At least one valid role must be provided.");
  }

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        message: "Authentication is required.",
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        message: "You do not have permission to access this resource.",
      });
    }

    return next();
  };
};

module.exports = authorizeRoles;
