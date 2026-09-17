const ALLOWED_ROLES = new Set(['admin', 'staff']);

/**
 * Gate for write actions. Requires both an authorized role (admin or staff,
 * never shopper) AND explicit confirmation - neither condition alone is enough.
 */
export function requireApproval({ role, confirmed }) {
  if (!ALLOWED_ROLES.has(role)) {
    return {
      approved: false,
      reason: `Role "${role}" is not authorized to perform this action. Must be "admin" or "staff".`,
    };
  }

  if (confirmed !== true) {
    return {
      approved: false,
      reason: 'This action requires explicit confirmation (confirmed: true).',
    };
  }

  return { approved: true };
}
