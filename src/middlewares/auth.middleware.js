import { jwtVerify, createRemoteJWKSet } from "jose";
import { logAuditEvent } from "../services/immudb.service.js";

let jwks;
function getJWKS() {
  if (jwks) {
    return jwks;
  }

  const baseUrlRaw = process.env.KEYCLOAK_BASE_URL;
  const realmRaw = process.env.KEYCLOAK_REALM;

  const baseUrl = typeof baseUrlRaw === 'string' ? baseUrlRaw.trim() : '';
  const realm = typeof realmRaw === 'string' ? realmRaw.trim() : '';

  if (!baseUrl || !realm) {
    throw new Error(
      `Keycloak env not configured. Required KEYCLOAK_BASE_URL and KEYCLOAK_REALM. Got KEYCLOAK_BASE_URL='${baseUrlRaw ?? ''}' KEYCLOAK_REALM='${realmRaw ?? ''}'`
    );
  }

  const normalizedBaseUrl = baseUrl.startsWith('http://') || baseUrl.startsWith('https://')
    ? baseUrl
    : `http://${baseUrl}`;

  const jwksUrl = new URL(`/realms/${realm}/protocol/openid-connect/certs`, normalizedBaseUrl);
  jwks = createRemoteJWKSet(jwksUrl);
  return jwks;
}

function flotillaVmClientId() {
  return String(process.env.FLOTILLA_VM_CLIENT_ID || 'flotilla-vm').trim();
}

export async function verifyJWT(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
      // Log missing token attempt
      await logAuditEvent('JWT_VERIFY_FAILED', 'unknown', {
        reason: 'MISSING_AUTH_TOKEN',
        ip: req.ip,
        endpoint: req.path,
        timestamp: new Date().toISOString(),
      });

      return res.status(401).json({
        status: "FAILED",
        error: "MISSING_AUTH_TOKEN",
      });
    }

    const token = authHeader.split(" ")[1];

    const { payload } = await jwtVerify(token, getJWKS(), {
      // DO NOT hard-fail issuer in dev / SSH tunnel setups
      // issuer removed intentionally
    });

    // Containment: tokens minted for the Flotilla FL client VMs (client
    // flotilla-vm, offline-token backed) are only good at the join gateway
    // (/p3dx/fl/vm-token, which doesn't use verifyJWT) — never as a user
    // session against the rest of the API.
    if (payload.azp && payload.azp === flotillaVmClientId()) {
      await logAuditEvent('JWT_VERIFY_FAILED', payload.preferred_username || payload.sub || 'unknown', {
        reason: 'VM_TOKEN_NOT_ALLOWED',
        ip: req.ip,
        endpoint: req.path,
        timestamp: new Date().toISOString(),
      });
      return res.status(403).json({
        status: "FAILED",
        error: "VM_TOKEN_NOT_ALLOWED",
      });
    }

    req.user = payload;
    next();
  } catch (err) {
    console.error("JWT VERIFY ERROR:", err.message);
    
    // Log JWT verification failure
    await logAuditEvent('JWT_VERIFY_FAILED', 'unknown', {
      reason: 'INVALID_OR_EXPIRED_TOKEN',
      error: err.message,
      ip: req.ip,
      endpoint: req.path,
      timestamp: new Date().toISOString(),
    });

    return res.status(401).json({
      status: "FAILED",
      error: "INVALID_OR_EXPIRED_TOKEN",
      ...(process.env.NODE_ENV === 'production'
        ? {}
        : { detail: err?.message || String(err) }),
    });
  }
}

/**
 * Service-to-service auth for internal callbacks: a Keycloak client-
 * credentials token (same realm JWKS as verifyJWT) whose azp is `clientId`
 * and whose realm roles include `role`. clientId may be a function so the
 * env var is read at request time.
 */
export function verifyServiceToken(clientId, role) {
  return async (req, res, next) => {
    const expectedClient = typeof clientId === 'function' ? clientId() : clientId;
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({
        status: "FAILED",
        error: "MISSING_AUTH_TOKEN",
      });
    }

    let payload;
    try {
      ({ payload } = await jwtVerify(authHeader.split(" ")[1], getJWKS()));
    } catch (err) {
      console.error("SERVICE JWT VERIFY ERROR:", err.message);
      return res.status(401).json({
        status: "FAILED",
        error: "INVALID_OR_EXPIRED_TOKEN",
      });
    }

    const roles = payload?.realm_access?.roles || [];
    if (!expectedClient || payload.azp !== expectedClient || !roles.includes(role)) {
      await logAuditEvent('SERVICE_TOKEN_REJECTED', payload?.azp || 'unknown', {
        expected_client: expectedClient,
        required_role: role,
        endpoint: req.path,
        timestamp: new Date().toISOString(),
      });
      return res.status(403).json({
        status: "FAILED",
        error: "SERVICE_NOT_ALLOWED",
      });
    }

    req.service = payload;
    next();
  };
}
