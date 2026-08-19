'use strict';

const crypto = require('node:crypto');
const { q, nowIso } = require('./db');
const { INTERNET_MODE } = require('./origin');

/**
 * Who is allowed to do what.
 *
 * Two kinds of staff account, and the difference is deliberate rather than
 * cosmetic:
 *
 *  - **administrator** - one account, password from the environment or the
 *    settings store. Sees every quiz in the system, and is the only account
 *    that can create teachers or read the server's join information.
 *  - **teacher** - many accounts, created by the administrator, each with its
 *    own username and password. Sees only the quizzes it created.
 *
 * The scoping is enforced here and in the route layer, not in the dashboards. A
 * teacher who edits the JavaScript, or calls the API directly, still cannot
 * reach another teacher's exam.
 */

// Long enough that guessing it over the internet is hopeless even without the
// lockout in front of it. Only enforced when the console is publicly reachable;
// a classroom LAN keeps the short, readable code that can be typed off a screen.
const MIN_PUBLIC_PASSWORD = 12;

// Teacher passwords are chosen by a person and typed daily, so the floor is
// lower than the administrator's - but never trivially short.
const MIN_TEACHER_PASSWORD = INTERNET_MODE ? MIN_PUBLIC_PASSWORD : 6;

// Anything on this list is what someone types when they are in a hurry.
const OBVIOUS = new Set([
  'password', 'password123', 'admin', 'administrator', 'adminadmin', 'letmein',
  'changeme', 'change-me', 'secret', 'exam', 'examexam', 'quiz', 'quizquiz',
  'teacher', 'invigilator', '123456789012', 'qwertyuiop', 'adminpassword',
]);

/** Stops the process with a readable block instead of a stack trace. */
function refuseToStart(lines) {
  const rule = '='.repeat(66);
  console.error(`\n${rule}`);
  console.error('  REFUSING TO START - the admin console would be exposed');
  console.error(rule);
  for (const line of lines) console.error(`  ${line}`);
  console.error(`${rule}\n`);
  process.exit(1);
}

/**
 * The administrator password.
 *
 * On a LAN, ADMIN_PASSWORD wins if set; otherwise one is generated ONCE and
 * persisted, so restarting the server mid-exam does not silently change the
 * invigilator's password. It is reprinted at every boot.
 *
 * Published to the internet, that is not good enough. The generated password is
 * eight hex characters - fine against a room of students who would have to be
 * seen typing it, hopeless against anyone on the internet with a script. Worse,
 * it is printed to stdout at every boot, and on a hosting platform stdout is a
 * log other people can read. So in internet mode the password must come from the
 * environment, must be long, and is never printed.
 */
function resolvePassword() {
  const fromEnv = process.env.ADMIN_PASSWORD;

  if (INTERNET_MODE) {
    if (!fromEnv) {
      refuseToStart([
        'PUBLIC_URL is set, so this exam system is reachable from the internet,',
        'but ADMIN_PASSWORD is not set.',
        '',
        `Set ADMIN_PASSWORD to at least ${MIN_PUBLIC_PASSWORD} characters and start again.`,
        '',
        'Generate an unguessable one with:',
        '  node -p "crypto.randomUUID()"',
      ]);
    }
    const value = String(fromEnv);
    if (value.trim().length < MIN_PUBLIC_PASSWORD) {
      refuseToStart([
        `ADMIN_PASSWORD is ${value.trim().length} characters. On a public address it must`,
        `be at least ${MIN_PUBLIC_PASSWORD}.`,
        '',
        'Anyone who guesses it can read every answer key and every result.',
      ]);
    }
    if (OBVIOUS.has(value.trim().toLowerCase())) {
      refuseToStart([
        'ADMIN_PASSWORD is one of the first things anyone would try.',
        'Choose something unguessable - it is the only thing standing between',
        'the internet and your answer keys.',
      ]);
    }
    return { password: value, source: 'env' };
  }

  if (fromEnv) return { password: fromEnv, source: 'env' };

  const stored = q.getSetting.get('admin_password');
  if (stored && stored.value) return { password: stored.value, source: 'stored' };

  // Hex only, so there are no 0/O or 1/I lookalikes to misread off a screen.
  const generated = crypto.randomBytes(4).toString('hex').toUpperCase();
  q.setSetting.run('admin_password', generated);
  return { password: generated, source: 'generated' };
}

const resolved = resolvePassword();
const PASSWORD = resolved.password;
const SOURCE = resolved.source;
const GENERATED = SOURCE !== 'env';

/**
 * Whether the boot banner may print the administrator password.
 *
 * On a LAN it must: the console is the only place the invigilator can read a
 * generated one. On a hosting platform stdout is a durable, often shared log,
 * and the operator already knows the password - they set it.
 */
const PRINTABLE = !INTERNET_MODE;

/** Replaces the stored administrator password. Used by `npm run password`. */
function setStoredPassword(next) {
  const value = String(next || '').trim();
  const floor = INTERNET_MODE ? MIN_PUBLIC_PASSWORD : 4;
  if (value.length < floor) {
    throw new Error(`Password must be at least ${floor} characters.`);
  }
  if (INTERNET_MODE) {
    // The stored password is ignored in internet mode - ADMIN_PASSWORD wins - so
    // saving one here would leave the operator convinced they changed something
    // that in fact still lets the old password in.
    throw new Error('This deployment reads ADMIN_PASSWORD from the environment. '
      + 'Change it there and restart, not with this command.');
  }
  q.setSetting.run('admin_password', value);
  return value;
}

/* ------------------------------------------------------------------ *
 * Password storage for teacher accounts
 * ------------------------------------------------------------------ */

/**
 * Teacher passwords are hashed; the administrator's is not.
 *
 * That asymmetry is not an oversight. The administrator password has to be
 * *displayed* - printed at boot, read back by `npm run password` - because on a
 * LAN there is nowhere else it can come from. Teacher passwords never need to be
 * shown again after they are set, so there is no reason to keep them
 * recoverable, and every reason not to: they are chosen by people, and people
 * reuse passwords.
 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(plain), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

function passwordMatches(plain, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  let expected;
  let actual;
  try {
    expected = Buffer.from(parts[2], 'base64url');
    actual = crypto.scryptSync(String(plain), Buffer.from(parts[1], 'base64url'),
      expected.length, SCRYPT);
  } catch {
    return false;
  }
  return crypto.timingSafeEqual(expected, actual);
}

/* ------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------ */

const sessions = new Map(); // token -> { role, teacherId, username, name, expiry }
const TTL_MS = 12 * 60 * 60 * 1000;

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const newToken = () => crypto.randomBytes(24).toString('hex');

/** Administrator login. Returns a token, or null if the password is wrong. */
function issue(password) {
  if (!safeEqual(password, PASSWORD)) return null;
  const token = newToken();
  sessions.set(token, {
    role: 'admin',
    teacherId: null,
    username: 'admin',
    name: 'Administrator',
    expiry: Date.now() + TTL_MS,
  });
  return token;
}

/**
 * Teacher login. Returns a token, or null for a wrong username, a wrong
 * password, or a disabled account - the caller cannot tell which, so a failed
 * login never confirms that an account exists.
 */
function issueTeacher(username, password) {
  const row = q.teacherByUsername.get(String(username || '').trim());
  if (!row || !row.is_active) return null;
  if (!passwordMatches(password, row.password_hash)) return null;

  q.touchTeacherLogin.run(nowIso(), row.teacher_id);
  const token = newToken();
  sessions.set(token, {
    role: 'teacher',
    teacherId: row.teacher_id,
    username: row.username,
    name: row.display_name,
    expiry: Date.now() + TTL_MS,
  });
  return token;
}

/** The session behind a token, or null. Expired tokens are dropped on sight. */
function sessionOf(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiry) {
    sessions.delete(token);
    return null;
  }
  return session;
}

/** Backwards-compatible truthy check: is this token a *valid staff* session? */
function verify(token) {
  return !!sessionOf(token);
}

/** Drops a session token (logout, or an admin walking away from a shared PC). */
function revoke(token) {
  if (token) sessions.delete(token);
}

/**
 * Drops every live session belonging to one teacher.
 *
 * Called when an account is disabled or deleted. Without it, "disable" would
 * only stop the *next* login: a teacher already holding a token would keep full
 * access to their exams for up to twelve hours after being locked out, which is
 * precisely the window in which somebody is disabled for a reason.
 */
function revokeTeacher(teacherId) {
  for (const [token, session] of sessions) {
    if (session.role === 'teacher' && session.teacherId === Number(teacherId)) {
      sessions.delete(token);
    }
  }
}

function tokenFrom(req) {
  const header = req.get('authorization') || '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return req.get('x-admin-token') || (req.query && req.query.adminToken) || null;
}

/** Middleware: any signed-in staff member. Attaches `req.staff`. */
function requireStaff(req, res, next) {
  const session = sessionOf(tokenFrom(req));
  if (!session) return res.status(401).json({ error: 'Sign in to continue.' });
  req.staff = session;
  return next();
}

/** Middleware: the administrator only. Attaches `req.staff`. */
function requireAdmin(req, res, next) {
  const session = sessionOf(tokenFrom(req));
  if (!session) return res.status(401).json({ error: 'Sign in to continue.' });
  if (session.role !== 'admin') {
    return res.status(403).json({ error: 'This action is restricted to the administrator.' });
  }
  req.staff = session;
  return next();
}

/* ------------------------------------------------------------------ *
 * Teacher accounts
 * ------------------------------------------------------------------ */

class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/i;

function assertUsablePassword(password) {
  const value = String(password || '');
  if (value.trim().length < MIN_TEACHER_PASSWORD) {
    throw new AuthError(400,
      `Password must be at least ${MIN_TEACHER_PASSWORD} characters.`);
  }
  if (OBVIOUS.has(value.trim().toLowerCase())) {
    throw new AuthError(400, 'That password is too easy to guess. Choose another.');
  }
}

function createTeacher({ username, displayName, password }) {
  const user = String(username || '').trim().toLowerCase();
  const name = String(displayName || '').trim();
  if (!USERNAME_RE.test(user)) {
    throw new AuthError(400, 'Username must be 3-32 characters: letters, numbers, '
      + 'dots, dashes or underscores.');
  }
  if (!name) throw new AuthError(400, 'Full name is required.');
  assertUsablePassword(password);
  if (q.teacherByUsername.get(user)) {
    throw new AuthError(409, `A teacher with the username "${user}" already exists.`);
  }
  const info = q.createTeacher.run(user, name, hashPassword(password), nowIso());
  return publicTeacher(q.teacherById.get(Number(info.lastInsertRowid)));
}

function updateTeacher(teacherId, { displayName, isActive, password }) {
  const row = q.teacherById.get(Number(teacherId));
  if (!row) throw new AuthError(404, 'No such teacher.');

  const name = displayName === undefined ? row.display_name : String(displayName).trim();
  if (!name) throw new AuthError(400, 'Full name is required.');
  const active = isActive === undefined ? !!row.is_active : !!isActive;

  q.updateTeacher.run(name, active ? 1 : 0, row.teacher_id);
  if (password !== undefined && password !== null && password !== '') {
    assertUsablePassword(password);
    q.updateTeacherPassword.run(hashPassword(password), row.teacher_id);
    // A password change is also a reason to invalidate whatever is out there.
    revokeTeacher(row.teacher_id);
  }
  if (!active) revokeTeacher(row.teacher_id);

  return publicTeacher(q.teacherById.get(row.teacher_id));
}

/**
 * Deletes a teacher. Their quizzes are NOT deleted - `owner_id` is set to NULL
 * by the foreign key, so the exams and every result recorded against them
 * survive and fall to the administrator. Losing a term of results because a
 * member of staff left would be indefensible.
 */
function deleteTeacher(teacherId) {
  const row = q.teacherById.get(Number(teacherId));
  if (!row) throw new AuthError(404, 'No such teacher.');
  revokeTeacher(row.teacher_id);
  q.deleteTeacher.run(row.teacher_id);
  return { deleted: row.teacher_id, username: row.username };
}

/** A teacher row as the dashboard sees it - never including the hash. */
function publicTeacher(row) {
  if (!row) return null;
  return {
    teacherId: row.teacher_id,
    username: row.username,
    displayName: row.display_name,
    isActive: !!row.is_active,
    quizCount: row.quiz_count === undefined ? undefined : row.quiz_count,
    createdAt: row.created_at,
    lastLogin: row.last_login,
  };
}

const listTeachers = () => q.listTeachers.all().map(publicTeacher);

module.exports = {
  PASSWORD, GENERATED, SOURCE, PRINTABLE, MIN_PUBLIC_PASSWORD, MIN_TEACHER_PASSWORD,
  issue, issueTeacher, sessionOf, verify, revoke, revokeTeacher, tokenFrom,
  requireStaff, requireAdmin, setStoredPassword,
  createTeacher, updateTeacher, deleteTeacher, listTeachers, publicTeacher,
  hashPassword, passwordMatches, AuthError,
};
