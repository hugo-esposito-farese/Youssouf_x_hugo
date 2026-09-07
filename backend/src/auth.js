const crypto = require('crypto');

// Pas de dépendance externe (bcrypt/jsonwebtoken) : le hachage et les tokens signés tiennent
// dans ~50 lignes avec le module crypto natif de Node, cohérent avec le reste du projet
// (pas d'ORM, pas de framework lourd — voir CLAUDE_youssouf.md).

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours : un chauffeur reste connecté sur son téléphone

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(payload, secret) {
  const body = base64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function issueToken(username, secret) {
  const payload = { username, iat: Date.now(), exp: Date.now() + SESSION_DURATION_MS };
  return sign(payload, secret);
}

function verifyToken(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expectedSig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

module.exports = { hashPassword, verifyPassword, issueToken, verifyToken };
