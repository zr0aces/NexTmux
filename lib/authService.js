"use strict";
// ── authService.js ──
// HTTP session management, cookie building, and IP-based login rate limiting.

const crypto = require("crypto");

const SESSION_TTL_MS = Math.max(
  60000,
  Number(process.env.SESSION_TTL_MS) || 7 * 24 * 60 * 60 * 1000
);
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 20;
const TRUST_PROXY = process.env.TRUST_PROXY === "1";

// In-memory stores (scoped to this module)
const sessions = new Map();        // token → { expiresAt }
const loginAttempts = new Map();   // ip → { count, resetAt }

function createToken() {
  return crypto.randomBytes(32).toString("hex");
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (TRUST_PROXY && typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

/**
 * Compare candidate password to expected in constant time, without leaking
 * the expected password length via a timing side-channel.
 */
function timingSafePasswordMatch(password, candidate) {
  const expected = Buffer.from(String(password || ""), "utf8");
  const provided = Buffer.from(String(candidate || ""), "utf8");
  const len = Math.max(expected.length, provided.length, 1);
  const a = Buffer.alloc(len);
  const b = Buffer.alloc(len);
  expected.copy(a);
  provided.copy(b);
  const contentMatch = crypto.timingSafeEqual(a, b);
  const lenMatch = expected.length === provided.length;
  return contentMatch && lenMatch;
}

function trimSessions(now = Date.now()) {
  for (const [token, meta] of sessions) {
    if (!meta || typeof meta.expiresAt !== "number" || now > meta.expiresAt) {
      sessions.delete(token);
    }
  }
}

function createSession() {
  const token = createToken();
  sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

function auth(req) {
  trimSessions();
  const cookie = req.headers.cookie || "";
  const token = cookie
    .split(";")
    .map(s => s.trim())
    .find(s => s.startsWith("token="))
    ?.slice(6);
  if (!token) return false;
  const meta = sessions.get(token);
  if (!meta) return false;
  meta.expiresAt = Date.now() + SESSION_TTL_MS;
  return true;
}

function buildAuthCookie(req, token) {
  const isSecure =
    req.socket?.encrypted || req.headers["x-forwarded-proto"] === "https";
  const secure = isSecure ? "; Secure" : "";
  return `token=${token}; Path=/; HttpOnly; SameSite=Strict${secure}`;
}

function trimLoginAttempts(now = Date.now()) {
  for (const [ip, state] of loginAttempts) {
    if (!state || now > state.resetAt) loginAttempts.delete(ip);
  }
}

function isLoginRateLimited(req) {
  const now = Date.now();
  trimLoginAttempts(now);
  const ip = getClientIp(req);
  const state = loginAttempts.get(ip);
  if (!state) return false;
  if (now > state.resetAt) {
    loginAttempts.delete(ip);
    return false;
  }
  return state.count >= MAX_LOGIN_ATTEMPTS;
}

function recordFailedLogin(req) {
  const now = Date.now();
  const ip = getClientIp(req);
  const state = loginAttempts.get(ip);
  if (!state || now > state.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  state.count += 1;
}

function clearFailedLogin(req) {
  loginAttempts.delete(getClientIp(req));
}

module.exports = {
  SESSION_TTL_MS,
  timingSafePasswordMatch,
  createSession,
  auth,
  buildAuthCookie,
  isLoginRateLimited,
  recordFailedLogin,
  clearFailedLogin,
};
