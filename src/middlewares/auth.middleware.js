import { jwtVerify, createRemoteJWKSet } from "jose";
import { webcrypto } from "crypto";
import { logAuditEvent } from "../services/immudb.service.js";

// Make crypto available globally for jose
globalThis.crypto = webcrypto;

const JWKS = createRemoteJWKSet(
  new URL(
    `${process.env.KEYCLOAK_BASE_URL}/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/certs`
  )
);

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

    const { payload } = await jwtVerify(token, JWKS, {
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
    });
  }
}
