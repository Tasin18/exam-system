'use strict';

/**
 * Access codes, abuse limits and the hardening that a publicly reachable exam
 * needs.
 *
 * On a LAN, being in the room was the gate: you cannot sit an exam you cannot
 * reach. Published to the internet the join URL is the only thing between a
 * stranger and the login form, and URLs get forwarded, screenshotted and pasted
 * into group chats. These tests pin down the replacement gate and the limits
 * that stop it being guessed.
 */

process.env.DB_FILE = ':memory:';
process.env.ADMIN_PASSWORD = 'access-code-test-pass';
process.env.PORT = process.env.TEST_PORT_CODE || '38631';
process.env.QUIET = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const { server } = require('../server');
const BASE = `http://127.0.0.1:${process.env.PORT}`;

let adminToken;
let quizId;

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, data };
}

const QUESTIONS = [
  { question_text: 'Capital of France?', options: ['Paris', 'Rome'], correct_option: 0 },
  { question_text: '2 + 2?', options: ['3', '4'], correct_option: 1 },
];

test.before(async () => {
  if (!server.listening) await once(server, 'listening');
  const login = await call('POST', '/api/admin/login', { password: 'access-code-test-pass' });
  adminToken = login.data.token;

  const created = await call('POST', '/api/admin/quizzes', {
    title: 'Gated Exam',
    durationMinutes: 30,
    isActive: true,
    accessCode: 'math-7q2',
    questions: QUESTIONS,
  }, adminToken);
  assert.equal(created.status, 201);
  quizId = created.data.quiz.quiz_id;
});

test.after(() => { server.close(); });

/* ================= The code itself ================= */

test('a code is normalised on the way in, so students cannot mistype it', async () => {
  const res = await call('GET', `/api/admin/quizzes/${quizId}`, null, adminToken);
  assert.equal(res.data.quiz.access_code, 'MATH-7Q2',
    'stored uppercase and stripped, because it is read off a projector');
  assert.equal(res.data.quiz.requires_code, true);
});

test('students are told a code is needed, but never told the code', async () => {
  const res = await call('GET', '/api/quiz/active');
  assert.equal(res.status, 200);
  assert.equal(res.data.requiresCode, true, 'the login page has to know to ask');
  assert.equal(res.data.accessCode, undefined);
  assert.equal(res.data.access_code, undefined);
  assert.ok(!JSON.stringify(res.data).toUpperCase().includes('MATH-7Q2'),
    'the public payload must not leak the code in any field');
});

test('logging in without the code is refused, and says so usefully', async () => {
  const res = await call('POST', '/api/auth/login', {
    studentId: 'S-100', name: 'No Code', quizId,
  });
  assert.equal(res.status, 403);
  assert.equal(res.data.codeRequired, true,
    'the login page reveals its code field off this flag');
  assert.match(res.data.error, /access code/i);
});

test('a wrong code is refused', async () => {
  const res = await call('POST', '/api/auth/login', {
    studentId: 'S-101', name: 'Wrong Code', quizId, accessCode: 'MATH-7Q3',
  });
  assert.equal(res.status, 403);
  assert.match(res.data.error, /not correct/i);
});

test('a refused login leaves no trace of the student on the roster', async () => {
  const res = await call('GET', '/api/admin/students', null, adminToken);
  const ids = res.data.students.map((s) => s.student_id);
  assert.ok(!ids.includes('S-100'), 'a stranger must not be able to seed the roster');
  assert.ok(!ids.includes('S-101'));
});

test('case and stray spaces do not cost a student their exam', async () => {
  const res = await call('POST', '/api/auth/login', {
    studentId: 'S-102', name: 'Right Code', quizId, accessCode: '  math-7q2  ',
  });
  assert.equal(res.status, 200);
  assert.ok(res.data.token);
});

test('clearing the code opens the exam again', async () => {
  const cleared = await call('PUT', `/api/admin/quizzes/${quizId}`, {
    accessCode: null,
  }, adminToken);
  assert.equal(cleared.status, 200);
  assert.equal(cleared.data.quiz.requires_code, false);

  const active = await call('GET', '/api/quiz/active');
  assert.equal(active.data.requiresCode, false);

  const login = await call('POST', '/api/auth/login', {
    studentId: 'S-103', name: 'No Gate', quizId,
  });
  assert.equal(login.status, 200, 'a quiz with no code behaves exactly as it always did');
});

test('an edit that does not mention the code leaves it alone', async () => {
  await call('PUT', `/api/admin/quizzes/${quizId}`, { accessCode: 'KEEP-ME' }, adminToken);
  const renamed = await call('PUT', `/api/admin/quizzes/${quizId}`, {
    title: 'Gated Exam (renamed)',
  }, adminToken);
  assert.equal(renamed.data.quiz.access_code, 'KEEP-ME',
    'renaming a quiz must not silently unlock it');

  // Nor may toggling activation, which is the click most likely to happen
  // moments before students arrive.
  await call('POST', `/api/admin/quizzes/${quizId}/activate`, { active: false }, adminToken);
  const reactivated = await call('POST', `/api/admin/quizzes/${quizId}/activate`, {}, adminToken);
  assert.equal(reactivated.data.quiz.access_code, 'KEEP-ME');
});

test('a duplicated quiz inherits the gate rather than publishing itself', async () => {
  const copy = await call('POST', `/api/admin/quizzes/${quizId}/duplicate`, {}, adminToken);
  assert.equal(copy.status, 201);
  assert.equal(copy.data.quiz.access_code, 'KEEP-ME');
  assert.equal(copy.data.quiz.is_active, false);
});

test('unusable codes are rejected at the door', async () => {
  const short = await call('PUT', `/api/admin/quizzes/${quizId}`, {
    accessCode: 'AB',
  }, adminToken);
  assert.equal(short.status, 400);
  assert.match(short.data.error, /4 and 24/);

  const punctuation = await call('PUT', `/api/admin/quizzes/${quizId}`, {
    accessCode: 'code!!',
  }, adminToken);
  assert.equal(punctuation.status, 400);
  assert.match(punctuation.data.error, /letters, numbers/i);

  const stillGated = await call('GET', `/api/admin/quizzes/${quizId}`, null, adminToken);
  assert.equal(stillGated.data.quiz.access_code, 'KEEP-ME',
    'a rejected edit must not have partially applied');
});

/* ================= Session hardening ================= */

test('logging out kills the admin token immediately', async () => {
  const login = await call('POST', '/api/admin/login', { password: 'access-code-test-pass' });
  const token = login.data.token;
  assert.equal((await call('GET', '/api/admin/session', null, token)).status, 200);

  const out = await call('POST', '/api/admin/logout', {}, token);
  assert.equal(out.status, 200);

  const after = await call('GET', '/api/admin/session', null, token);
  assert.equal(after.status, 401,
    'a token that outlives the logout is a token left on a shared machine');
});

test('repeated wrong admin passwords lock the caller out', async () => {
  let sawLockout = false;
  for (let i = 0; i < 8; i += 1) {
    const res = await call('POST', '/api/admin/login', { password: `guess-${i}` });
    if (res.status === 429) {
      sawLockout = true;
      assert.match(res.data.error, /too many/i);
      break;
    }
    assert.equal(res.status, 401);
  }
  assert.ok(sawLockout, 'unlimited guesses against a public password box is not a login');

  // And the lockout is real: the correct password does not get through either,
  // otherwise an attacker could keep guessing between valid logins.
  const correct = await call('POST', '/api/admin/login', { password: 'access-code-test-pass' });
  assert.equal(correct.status, 429);
});

/* ================= Transport hardening ================= */

test('every response carries the headers a public deployment needs', async () => {
  const res = await fetch(`${BASE}/`);
  const csp = res.headers.get('content-security-policy') || '';
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/, 'an exam inside an iframe defeats the lockdown');
  assert.match(csp, /script-src 'self'/, 'no third-party or inline script may run');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('permissions-policy') || '', /camera=\(\)/);
});

test('HSTS is not claimed over a plaintext LAN connection', async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.headers.get('strict-transport-security'), null,
    'promising HSTS over http would pin a scheme this server does not serve');
});

test('the health probe answers without a session and says which mode it is in', async () => {
  const res = await fetch(`${BASE}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.mode, 'lan');
  assert.match(res.headers.get('cache-control') || '', /no-store/);
});
