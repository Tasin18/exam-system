'use strict';

/**
 * End-to-end checks against a real HTTP server and a real (in-memory) SQLite
 * database. Run with: npm test
 */

process.env.DB_FILE = ':memory:';
process.env.ADMIN_PASSWORD = 'test-pass';
process.env.PORT = process.env.TEST_PORT || '38621';
process.env.QUIET = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const { server } = require('../server');
const BASE = `http://127.0.0.1:${process.env.PORT}`;

let adminToken;
let quizId;
let questions;

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

test.before(async () => {
  if (!server.listening) await once(server, 'listening');
});

test.after(() => { server.close(); });

/* ------------------------------------------------------------------ */

test('admin routes reject unauthenticated callers', async () => {
  const res = await call('GET', '/api/admin/quizzes');
  assert.equal(res.status, 401);
});

test('admin login rejects a wrong password and accepts the right one', async () => {
  const bad = await call('POST', '/api/admin/login', { password: 'nope' });
  assert.equal(bad.status, 401);

  const good = await call('POST', '/api/admin/login', { password: 'test-pass' });
  assert.equal(good.status, 200);
  assert.ok(good.data.token);
  adminToken = good.data.token;
});

test('quiz creation validates questions', async () => {
  const noQuestions = await call('POST', '/api/admin/quizzes',
    { title: 'Bad', durationMinutes: 10, questions: [] }, adminToken);
  assert.equal(noQuestions.status, 400);

  const badIndex = await call('POST', '/api/admin/quizzes', {
    title: 'Bad', durationMinutes: 10,
    questions: [{ question_text: 'Q', options: ['a', 'b'], correct_option: 5 }],
  }, adminToken);
  assert.equal(badIndex.status, 400);

  const badDuration = await call('POST', '/api/admin/quizzes', {
    title: 'Bad', durationMinutes: 0,
    questions: [{ question_text: 'Q', options: ['a', 'b'], correct_option: 0 }],
  }, adminToken);
  assert.equal(badDuration.status, 400);
});

test('admin creates and activates a quiz', async () => {
  const created = await call('POST', '/api/admin/quizzes', {
    title: 'Unit Test Exam',
    durationMinutes: 30,
    questions: [
      { question_text: '2 + 2 = ?', options: ['3', '4', '5', '6'], correct_option: 1 },
      { question_text: 'Capital of France?', options: ['Rome', 'Madrid', 'Paris', 'Bonn'], correct_option: 2 },
      { question_text: 'Largest planet?', options: ['Mars', 'Jupiter', 'Venus', 'Earth'], correct_option: 1 },
      { question_text: 'H2O is?', options: ['Salt', 'Water', 'Acid', 'Base'], correct_option: 1 },
    ],
  }, adminToken);

  assert.equal(created.status, 201);
  quizId = created.data.quiz.quiz_id;

  const activated = await call('POST', `/api/admin/quizzes/${quizId}/activate`, { active: true }, adminToken);
  assert.equal(activated.status, 200);
  assert.equal(activated.data.quiz.is_active, true);

  const active = await call('GET', '/api/quiz/active');
  assert.equal(active.data.active, true);
  assert.equal(active.data.quizId, quizId);
  assert.equal(active.data.questionCount, 4);
});

test('student logs in and receives questions without the answer key', async () => {
  const login = await call('POST', '/api/auth/login', { studentId: 'CSE-001', name: 'John Doe' });
  assert.equal(login.status, 200);
  assert.ok(login.data.token);
  assert.equal(login.data.resumed, false);

  const exam = await call('GET', '/api/quiz/exam', null, login.data.token);
  assert.equal(exam.status, 200);
  assert.equal(exam.data.questions.length, 4);

  for (const question of exam.data.questions) {
    assert.equal(question.correct_option, undefined,
      'correct_option must never be sent to a student client');
  }
  assert.ok(!JSON.stringify(exam.data).includes('correct_option'));

  questions = exam.data.questions;
  globalThis.__student1 = login.data.token;
});

test('login is rejected without an ID or a name', async () => {
  assert.equal((await call('POST', '/api/auth/login', { studentId: '', name: 'X' })).status, 400);
  assert.equal((await call('POST', '/api/auth/login', { studentId: 'X', name: '  ' })).status, 400);
});

test('exam endpoints reject a bogus session token', async () => {
  assert.equal((await call('GET', '/api/quiz/exam', null, 'deadbeef')).status, 401);
  assert.equal((await call('POST', '/api/quiz/submit', { answers: {} }, 'deadbeef')).status, 401);
});

/** Questions arrive in a per-student shuffled order, so find them by text. */
function byText(fragment) {
  const found = questions.find((q) => q.question_text.includes(fragment));
  assert.ok(found, `no question matching "${fragment}"`);
  return found;
}

test('progress autosave persists answers', async () => {
  const token = globalThis.__student1;
  const answers = {};
  answers[`q${byText('2 + 2').question_id}`] = 1; // correct

  const saved = await call('POST', '/api/quiz/progress', { answers }, token);
  assert.equal(saved.status, 200);

  const exam = await call('GET', '/api/quiz/exam', null, token);
  assert.deepEqual(exam.data.savedAnswers, answers);
});

test('manual submit is graded server-side and merges autosaved answers', async () => {
  const token = globalThis.__student1;
  // "2 + 2" was autosaved correct. Send France correct, planet wrong, H2O unanswered.
  const answers = {};
  answers[`q${byText('France').question_id}`] = 2;  // Paris - correct
  answers[`q${byText('planet').question_id}`] = 0;  // Mars - wrong

  const res = await call('POST', '/api/quiz/submit',
    { answers, submissionType: 'MANUAL' }, token);

  assert.equal(res.status, 200);
  assert.equal(res.data.result.status, 'SUBMITTED');
  assert.equal(res.data.result.submissionType, 'MANUAL');

  // The mark is graded server-side but released manually, so it must not be
  // anywhere in the student's response.
  assert.equal(res.data.result.score, undefined);
  assert.equal(res.data.result.correct, undefined);
  assert.equal(res.data.result.total, undefined);
  assert.ok(!/\bscore\b|\bcorrect\b/.test(JSON.stringify(res.data)),
    'no scoring field may appear in a student response');

  // The invigilator still sees the real mark.
  const results = await call('GET', `/api/admin/results/${quizId}`, null, adminToken);
  const row = results.data.results.find((r) => r.studentId === 'CSE-001');
  assert.equal(row.correct, 2);
  assert.equal(row.total, 4);
  assert.equal(row.score, 50);
});

test('the submitted token is invalidated', async () => {
  const res = await call('GET', '/api/quiz/exam', null, globalThis.__student1);
  assert.equal(res.status, 401);
});

test('a second login attempt is blocked with 403 and the documented message', async () => {
  const res = await call('POST', '/api/auth/login', { studentId: 'CSE-001', name: 'John Doe' });
  assert.equal(res.status, 403);
  assert.match(res.data.error, /Attempt already recorded\. Contact administrator for permission\./);
  assert.equal(res.data.status, 'SUBMITTED');
});

test('admin reset-attempt grants a retake', async () => {
  const reset = await call('POST', '/api/admin/reset-attempt',
    { studentId: 'CSE-001', quizId }, adminToken);
  assert.equal(reset.status, 200);
  assert.equal(reset.data.reset.previousStatus, 'SUBMITTED');

  const again = await call('POST', '/api/auth/login', { studentId: 'CSE-001', name: 'John Doe' });
  assert.equal(again.status, 200);
  assert.ok(again.data.token);
  globalThis.__student1 = again.data.token;
});

test('reset-attempt 404s when there is no attempt on record', async () => {
  const res = await call('POST', '/api/admin/reset-attempt',
    { studentId: 'GHOST-999', quizId }, adminToken);
  assert.equal(res.status, 404);
});

test('an interrupted student resumes the same attempt, not a new one', async () => {
  const first = await call('POST', '/api/auth/login', { studentId: 'CSE-002', name: 'Jane Roe' });
  assert.equal(first.data.resumed, false);
  const firstEndsAt = first.data.endsAt;

  const second = await call('POST', '/api/auth/login', { studentId: 'CSE-002', name: 'Jane Roe' });
  assert.equal(second.status, 200);
  assert.equal(second.data.resumed, true);
  // The clock must NOT restart on re-entry.
  assert.equal(second.data.endsAt, firstEndsAt);
  // The old token is invalidated so only one live session exists.
  assert.equal((await call('GET', '/api/quiz/exam', null, first.data.token)).status, 401);
  globalThis.__student2 = second.data.token;
});

test('a focus violation terminates the attempt via flag-submit', async () => {
  const token = globalThis.__student2;
  const answers = {};
  // By text, not position: this student's order is shuffled independently.
  answers[`q${byText('2 + 2').question_id}`] = 1; // one correct

  const res = await call('POST', '/api/quiz/flag-submit',
    { answers, reason: 'Tab switch or minimized' }, token);

  assert.equal(res.status, 200);
  assert.equal(res.data.result.status, 'TERMINATED');
  assert.equal(res.data.result.submissionType, 'AUTO_TERMINATED');
  assert.equal(res.data.result.reason, 'Tab switch or minimized');
  assert.equal(res.data.result.score, undefined, 'a terminated student sees no mark either');

  const results = await call('GET', `/api/admin/results/${quizId}`, null, adminToken);
  const row = results.data.results.find((r) => r.studentId === 'CSE-002');
  assert.equal(row.correct, 1);
  assert.equal(row.score, 25);
});

test('a terminated student cannot log back in', async () => {
  const res = await call('POST', '/api/auth/login', { studentId: 'CSE-002', name: 'Jane Roe' });
  assert.equal(res.status, 403);
  assert.equal(res.data.status, 'TERMINATED');
});

test('a double submit does not create a second result', async () => {
  const login = await call('POST', '/api/auth/login', { studentId: 'CSE-003', name: 'Sam Ray' });
  const token = login.data.token;

  const first = await call('POST', '/api/quiz/submit', { answers: {} }, token);
  assert.equal(first.status, 200);
  const second = await call('POST', '/api/quiz/submit', { answers: {} }, token);
  assert.equal(second.status, 401, 'the token is consumed by the first submit');

  const results = await call('GET', `/api/admin/results/${quizId}`, null, adminToken);
  const rows = results.data.results.filter((r) => r.studentId === 'CSE-003');
  assert.equal(rows.length, 1);
});

test('force-submit terminates an in-progress attempt', async () => {
  await call('POST', '/api/auth/login', { studentId: 'CSE-004', name: 'Ada Byron' });

  const forced = await call('POST', '/api/admin/force-submit',
    { studentId: 'CSE-004', quizId }, adminToken);
  assert.equal(forced.status, 200);
  assert.equal(forced.data.result.status, 'TERMINATED');
  assert.equal(forced.data.result.submissionType, 'ADMIN_FORCED');

  const again = await call('POST', '/api/admin/force-submit',
    { studentId: 'CSE-004', quizId }, adminToken);
  assert.equal(again.status, 409);
});

test('the server enforces the time limit regardless of the client', async () => {
  // A one-minute quiz whose start_time is backdated past the deadline.
  const created = await call('POST', '/api/admin/quizzes', {
    title: 'Expiry Test', durationMinutes: 1,
    questions: [{ question_text: 'Q', options: ['a', 'b'], correct_option: 0 }],
  }, adminToken);
  const shortQuizId = created.data.quiz.quiz_id;
  await call('POST', `/api/admin/quizzes/${shortQuizId}/activate`, { active: true }, adminToken);

  const login = await call('POST', '/api/auth/login', { studentId: 'CSE-005', name: 'Late Larry' });
  assert.equal(login.status, 200);

  const { db } = require('../src/db');
  db.prepare('UPDATE attempts SET start_time = ? WHERE student_id = ? AND quiz_id = ?')
    .run(new Date(Date.now() - 5 * 60_000).toISOString(), 'CSE-005', shortQuizId);

  // Any authenticated action now closes the attempt as TIME_EXPIRED.
  const exam = await call('GET', '/api/quiz/exam', null, login.data.token);
  assert.equal(exam.status, 403);

  const results = await call('GET', `/api/admin/results/${shortQuizId}`, null, adminToken);
  const row = results.data.results.find((r) => r.studentId === 'CSE-005');
  assert.equal(row.status, 'SUBMITTED');
  assert.equal(row.submissionType, 'TIME_EXPIRED');

  // Restore the main quiz as the active one for any later tests.
  await call('POST', `/api/admin/quizzes/${quizId}/activate`, { active: true }, adminToken);
});

test('only one quiz can be active at a time', async () => {
  const quizzes = await call('GET', '/api/admin/quizzes', null, adminToken);
  const active = quizzes.data.quizzes.filter((row) => row.is_active);
  assert.equal(active.length, 1);
  assert.equal(active[0].quiz_id, quizId);
});

test('questions cannot be edited while a student is mid-exam', async () => {
  await call('POST', '/api/admin/reset-attempt', { studentId: 'CSE-001', quizId }, adminToken);
  await call('POST', '/api/auth/login', { studentId: 'CSE-001', name: 'John Doe' });

  const res = await call('PUT', `/api/admin/quizzes/${quizId}`, {
    questions: [{ question_text: 'New', options: ['a', 'b'], correct_option: 0 }],
  }, adminToken);
  assert.equal(res.status, 409);
  assert.match(res.data.error, /mid-exam/);

  // Title-only edits are still allowed.
  const titleOnly = await call('PUT', `/api/admin/quizzes/${quizId}`,
    { title: 'Unit Test Exam (renamed)' }, adminToken);
  assert.equal(titleOnly.status, 200);
  assert.equal(titleOnly.data.quiz.title, 'Unit Test Exam (renamed)');
});

test('the monitor snapshot reports derived statuses', async () => {
  const res = await call('GET', `/api/admin/monitor/${quizId}`, null, adminToken);
  assert.equal(res.status, 200);
  assert.ok(res.data.students.length >= 4);
  assert.ok(res.data.counts.IN_PROGRESS >= 1);
  assert.ok(res.data.counts.AUTO_TERMINATED >= 2);

  const terminated = res.data.students.find((s) => s.studentId === 'CSE-002');
  assert.equal(terminated.display, 'AUTO_TERMINATED');
  assert.equal(terminated.reason, 'Tab switch or minimized');
  assert.ok(terminated.violations >= 1);
});

test('violation flags are recorded for the invigilator', async () => {
  const res = await call('GET', `/api/admin/monitor/${quizId}`, null, adminToken);
  const flag = res.data.flags.find((f) => f.studentId === 'CSE-002');
  assert.ok(flag, 'a flag should exist for the terminated student');
  assert.equal(flag.severity, 'FATAL');
});

test('CSV export contains a header and one row per attempt', async () => {
  const res = await fetch(`${BASE}/api/admin/results/${quizId}/export.csv`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename=/);

  const text = await res.text();
  const lines = text.trim().split(/\r?\n/);
  // Marks lead the score columns: a mark sheet is what this export is for.
  assert.match(lines[0], /Student ID,Name,Status,Marks,Total Marks,Score \(%\),Correct,Questions/);
  assert.ok(lines.length >= 4);
});

test('CSV export accepts the query-string token used by the download button', async () => {
  // The browser's own download mechanism cannot set an Authorization header.
  const res = await fetch(`${BASE}/api/admin/results/${quizId}/export.csv`
    + `?adminToken=${encodeURIComponent(adminToken)}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
});

test('CSV export rejects an unauthenticated request', async () => {
  const res = await fetch(`${BASE}/api/admin/results/${quizId}/export.csv`);
  assert.equal(res.status, 401);

  const badQuery = await fetch(`${BASE}/api/admin/results/${quizId}/export.csv?adminToken=bogus`);
  assert.equal(badQuery.status, 401);
});

test('join information is administrator-only', async () => {
  // These describe how to reach the server and what to project on the wall.
  // They belong to whoever runs the room, not to every teacher with an account.
  const anon = await fetch(`${BASE}/api/network`);
  assert.equal(anon.status, 401);
  const anonQr = await fetch(`${BASE}/api/qr.png`);
  assert.equal(anonQr.status, 401);
});

test('the network endpoint and QR image are served to the administrator', async () => {
  const net = await call('GET', '/api/network', null, adminToken);
  assert.equal(net.status, 200);
  assert.match(net.data.url, /^http:\/\/[\d.]+:\d+$/);

  const qr = await fetch(`${BASE}/api/qr.png?adminToken=${adminToken}`);
  assert.equal(qr.status, 200);
  assert.equal(qr.headers.get('content-type'), 'image/png');
  assert.ok((await qr.arrayBuffer()).byteLength > 100);
});

test('unknown API routes 404 as JSON', async () => {
  const res = await call('GET', '/api/nope');
  assert.equal(res.status, 404);
  assert.equal(res.data.error, 'Unknown endpoint.');
});
