import { jwtVerify, createRemoteJWKSet } from "jose";
import { webcrypto } from "crypto";
import { logAuditEvent } from "../services/immudb.service.js";

// Make crypto available globally for jose
globalThis.crypto = webcrypto;

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
      // ⚠️ DO NOT hard-fail issuer in dev / SSH tunnel setups
      // issuer removed intentionally
    });

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
