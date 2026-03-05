export function requireRole(role) {
  return (req, res, next) => {
    const roles =
      req.user?.realm_access?.roles || [];

    if (!roles.includes(role)) {
      return res.status(403).json({
        status: 'FAILED',
        error: 'INSUFFICIENT_ROLE',
      });
    }

    next();
  };
}

export function requireAnyRole(requiredRoles) {
  const required = Array.isArray(requiredRoles) ? requiredRoles : [];

  return (req, res, next) => {
    const roles = req.user?.realm_access?.roles || [];

    if (!required.some(r => roles.includes(r))) {
      return res.status(403).json({
        status: 'FAILED',
        error: 'INSUFFICIENT_ROLE',
      });
    }

    next();
  };
}
