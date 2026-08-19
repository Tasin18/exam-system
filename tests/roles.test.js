'use strict';

/**
 * Teacher and administrator roles.
 *
 * The two dashboards differ in what markup they load, which is presentation and
 * proves nothing. What matters is that a teacher calling the API directly —
 * with a valid token, from the browser console, past every hidden button —
 * still cannot reach another teacher's exam. Everything here is asserted at the
 * HTTP and socket layer for exactly that reason.
 */

process.env.DB_FILE = ':memory:';
process.env.ADMIN_PASSWORD = 'roles-test-admin-password';
process.env.PORT = process.env.TEST_PORT_ROLES || '38641';
process.env.QUIET = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { io } = require('socket.io-client');

const { server } = require('../server');
const { q } = require('../src/db');
const BASE = `http://127.0.0.1:${process.env.PORT}`;

const sockets = [];

function connect() {
  const socket = io(BASE, { transports: ['websocket'], forceNew: true });
  sockets.push(socket);
  return socket;
}

/** Resolves with the first `event` payload, or 'quiet' if none arrives in time. */
function raceForEvent(socket, event, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      resolve('quiet');
    }, ms);
    const handler = (payload) => {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

let adminToken;
let alice;   // teacher token
let bob;     // teacher token
let aliceQuiz;
let bobQuiz;

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

const makeQuiz = (title, token, extra) => call('POST', '/api/admin/quizzes', {
  title, durationMinutes: 30, questions: QUESTIONS, ...(extra || {}),
}, token);

test.before(async () => {
  if (!server.listening) await once(server, 'listening');
  adminToken = (await call('POST', '/api/admin/login',
    { password: 'roles-test-admin-password' })).data.token;

  for (const t of [
    { displayName: 'Alice Teacher', username: 'alice', password: 'alice-password' },
    { displayName: 'Bob Teacher', username: 'bob', password: 'bob-password' },
  ]) {
    const res = await call('POST', '/api/admin/teachers', t, adminToken);
    assert.equal(res.status, 201, JSON.stringify(res.data));
  }

  alice = (await call('POST', '/api/teacher/login',
    { username: 'alice', password: 'alice-password' })).data.token;
  bob = (await call('POST', '/api/teacher/login',
    { username: 'bob', password: 'bob-password' })).data.token;

  aliceQuiz = (await makeQuiz('Alice Midterm', alice)).data.quiz.quiz_id;
  bobQuiz = (await makeQuiz('Bob Midterm', bob)).data.quiz.quiz_id;
});

test.after(() => {
  sockets.forEach((socket) => socket.close());
  server.close();
});

/* ================= Accounts ================= */

test('a teacher signs in with their own credentials, not the admin password', async () => {
  const bad = await call('POST', '/api/teacher/login',
    { username: 'alice', password: 'roles-test-admin-password' });
  assert.equal(bad.status, 401);

  const good = await call('POST', '/api/teacher/login',
    { username: 'alice', password: 'alice-password' });
  assert.equal(good.status, 200);
  assert.equal(good.data.role, 'teacher');
  assert.equal(good.data.name, 'Alice Teacher');
});

test('a failed sign-in does not reveal whether the account exists', async () => {
  const noSuchUser = await call('POST', '/api/teacher/login',
    { username: 'nobody-here', password: 'whatever-password' });
  const wrongPassword = await call('POST', '/api/teacher/login',
    { username: 'alice', password: 'wrong-password' });
  assert.equal(noSuchUser.status, wrongPassword.status);
  assert.equal(noSuchUser.data.error, wrongPassword.data.error);
});

test('teacher passwords are hashed, never stored where they can be read back', () => {
  const row = q.teacherByUsername.get('alice');
  assert.ok(row.password_hash.startsWith('scrypt$'));
  assert.ok(!row.password_hash.includes('alice-password'));
  assert.equal(row.password, undefined, 'there is no plaintext column at all');
});

test('the session endpoint reports who you are, for the dashboard to render', async () => {
  const asTeacher = await call('GET', '/api/admin/session', null, alice);
  assert.equal(asTeacher.data.role, 'teacher');
  assert.equal(asTeacher.data.name, 'Alice Teacher');

  const asAdmin = await call('GET', '/api/admin/session', null, adminToken);
  assert.equal(asAdmin.data.role, 'admin');
});

/* ================= Ownership ================= */

test('a teacher sees only their own quizzes; the admin sees every one', async () => {
  const mine = await call('GET', '/api/admin/quizzes', null, alice);
  assert.deepEqual(mine.data.quizzes.map((x) => x.title), ['Alice Midterm']);

  const all = await call('GET', '/api/admin/quizzes', null, adminToken);
  const titles = all.data.quizzes.map((x) => x.title);
  assert.ok(titles.includes('Alice Midterm') && titles.includes('Bob Midterm'));
  assert.equal(all.data.quizzes.find((x) => x.title === 'Alice Midterm').owner_name,
    'Alice Teacher', 'the admin list says whose quiz each one is');
});

test('another teacher\'s quiz reads as missing, not as forbidden', async () => {
  const res = await call('GET', `/api/admin/quizzes/${bobQuiz}`, null, alice);
  assert.equal(res.status, 404,
    '403 would confirm the quiz exists and let a teacher walk the id space');
});

test('a teacher cannot edit, activate, duplicate or delete another\'s quiz', async () => {
  const attempts = [
    ['PUT', `/api/admin/quizzes/${bobQuiz}`, { title: 'Hijacked' }],
    ['POST', `/api/admin/quizzes/${bobQuiz}/activate`, {}],
    ['POST', `/api/admin/quizzes/${bobQuiz}/duplicate`, {}],
    ['DELETE', `/api/admin/quizzes/${bobQuiz}`, null],
  ];
  for (const [method, path, body] of attempts) {
    const res = await call(method, path, body, alice);
    assert.equal(res.status, 404, `${method} ${path} must not succeed`);
  }
  const survived = await call('GET', `/api/admin/quizzes/${bobQuiz}`, null, bob);
  assert.equal(survived.data.quiz.title, 'Bob Midterm');
});

test('a teacher cannot read another\'s monitor, results or exports', async () => {
  for (const path of [
    `/api/admin/monitor/${bobQuiz}`,
    `/api/admin/results/${bobQuiz}`,
    `/api/admin/results/${bobQuiz}/export.csv`,
    `/api/admin/results/${bobQuiz}/answers.pdf`,
    `/api/admin/results/${bobQuiz}/student/S-1`,
  ]) {
    const res = await call('GET', path, null, alice);
    assert.equal(res.status, 404, `${path} leaked`);
  }
});

test('a teacher cannot override an attempt on another\'s quiz', async () => {
  const reset = await call('POST', '/api/admin/reset-attempt',
    { studentId: 'S-1', quizId: bobQuiz }, alice);
  assert.equal(reset.status, 404);

  const force = await call('POST', '/api/admin/force-submit',
    { studentId: 'S-1', quizId: bobQuiz }, alice);
  assert.equal(force.status, 404);
});

test('a quiz a teacher creates is stamped as theirs, whatever they claim', async () => {
  const res = await call('POST', '/api/admin/quizzes', {
    title: 'Ownership Probe',
    durationMinutes: 10,
    questions: QUESTIONS,
    // A teacher trying to plant a quiz in someone else's list.
    ownerId: 999,
    owner_id: 999,
  }, alice);
  assert.equal(res.status, 201);
  const row = q.getQuiz.get(res.data.quiz.quiz_id);
  const aliceRow = q.teacherByUsername.get('alice');
  assert.equal(row.owner_id, aliceRow.teacher_id);
});

test('an admin-created quiz belongs to nobody, and stays invisible to teachers', async () => {
  const res = await makeQuiz('Admin Paper', adminToken);
  assert.equal(res.status, 201);
  assert.equal(q.getQuiz.get(res.data.quiz.quiz_id).owner_id, null);

  const list = await call('GET', '/api/admin/quizzes', null, alice);
  assert.ok(!list.data.quizzes.some((x) => x.title === 'Admin Paper'));
});

/* ================= Admin-only powers ================= */

test('teacher accounts are the administrator\'s alone', async () => {
  for (const [method, path, body] of [
    ['GET', '/api/admin/teachers', null],
    ['POST', '/api/admin/teachers', { username: 'mole', displayName: 'M', password: 'password-x1' }],
    ['PUT', '/api/admin/teachers/1', { isActive: false }],
    ['DELETE', '/api/admin/teachers/1', null],
  ]) {
    const res = await call(method, path, body, alice);
    assert.equal(res.status, 403, `${method} ${path} must be admin-only`);
    assert.match(res.data.error, /administrator/i);
  }
});

test('join information and the QR code are the administrator\'s alone', async () => {
  assert.equal((await call('GET', '/api/network', null, alice)).status, 403);
  const qr = await fetch(`${BASE}/api/qr.png?adminToken=${alice}`);
  assert.equal(qr.status, 403);
  assert.equal((await call('GET', '/api/network', null, adminToken)).status, 200);
});

test('removing a student from the roster is the administrator\'s alone', async () => {
  // It cascades across every teacher's quizzes, so it cannot belong to one of them.
  const res = await call('DELETE', '/api/admin/students/S-anything', null, alice);
  assert.equal(res.status, 403);
});

test('a teacher\'s roster is limited to students who sat their own exams', async () => {
  await call('POST', `/api/admin/quizzes/${bobQuiz}/activate`, {}, bob);
  await call('POST', '/api/auth/login',
    { studentId: 'BOB-STUDENT', name: 'Only Bobs', quizId: bobQuiz });

  const alices = await call('GET', '/api/admin/students', null, alice);
  assert.ok(!alices.data.students.some((s) => s.student_id === 'BOB-STUDENT'),
    'the full roster is the whole school and would leak every cohort');

  const bobs = await call('GET', '/api/admin/students', null, bob);
  assert.ok(bobs.data.students.some((s) => s.student_id === 'BOB-STUDENT'));

  const admins = await call('GET', '/api/admin/students', null, adminToken);
  assert.ok(admins.data.students.some((s) => s.student_id === 'BOB-STUDENT'));
});

/* ================= The live monitor ================= */

test('the monitor lists the people sitting the exam, not the whole school', async () => {
  // Two students exist by now; only one of them has an attempt on Bob's quiz.
  const snap = await call('GET', `/api/admin/monitor/${bobQuiz}`, null, bob);
  assert.equal(snap.status, 200);
  assert.deepEqual(snap.data.students.map((s) => s.studentId), ['BOB-STUDENT']);
  assert.equal(snap.data.counts.SITTING, 1);
  assert.equal(snap.data.counts.NOT_STARTED, undefined,
    'there is no roster to be absent from any more');

  const roster = await call('GET', '/api/admin/students', null, adminToken);
  assert.ok(roster.data.students.length >= 1);
});

test('a teacher socket cannot watch another teacher\'s exam', async () => {
  const socket = connect();
  await once(socket, 'connect');

  // Armed before the join: the server pushes the first snapshot during the join
  // itself, so a listener attached after the ack would miss it and the test
  // would pass for the wrong reason.
  const onJoin = raceForEvent(socket, 'admin:snapshot', 700);
  const ack = await new Promise((resolve) => socket.emit('admin:join',
    { token: alice, quizId: bobQuiz }, resolve));
  assert.equal(ack.ok, true, 'the session itself is valid');
  assert.equal(ack.role, 'teacher');
  assert.equal(await onJoin, 'quiet', "joining must not hand over another teacher's exam");

  const onWatch = raceForEvent(socket, 'admin:snapshot', 700);
  socket.emit('admin:watch', { quizId: bobQuiz });
  assert.equal(await onWatch, 'quiet',
    'admin:watch must re-check ownership, not trust the join');
});

test('a teacher socket does receive its own exam', async () => {
  const socket = connect();
  await once(socket, 'connect');

  const incoming = raceForEvent(socket, 'admin:snapshot', 2000);
  const ack = await new Promise((resolve) => socket.emit('admin:join',
    { token: bob, quizId: bobQuiz }, resolve));
  assert.equal(ack.ok, true);

  const snapshot = await incoming;
  assert.notEqual(snapshot, 'quiet', 'the owner must get their own live feed');
  assert.equal(snapshot.quiz.quiz_id, bobQuiz);
});

/* ================= Account lifecycle ================= */

test('disabling a teacher cuts the session they are already holding', async () => {
  const carol = await call('POST', '/api/admin/teachers',
    { username: 'carol', displayName: 'Carol Teacher', password: 'carol-password' }, adminToken);
  const id = carol.data.teacher.teacherId;
  const token = (await call('POST', '/api/teacher/login',
    { username: 'carol', password: 'carol-password' })).data.token;
  assert.equal((await call('GET', '/api/admin/session', null, token)).status, 200);

  await call('PUT', `/api/admin/teachers/${id}`, { isActive: false }, adminToken);

  assert.equal((await call('GET', '/api/admin/session', null, token)).status, 401,
    'a twelve-hour window of access after being locked out is not being locked out');
  assert.equal((await call('POST', '/api/teacher/login',
    { username: 'carol', password: 'carol-password' })).status, 401);
});

test('changing a password signs out whoever was using the old one', async () => {
  const token = (await call('POST', '/api/teacher/login',
    { username: 'bob', password: 'bob-password' })).data.token;
  const id = q.teacherByUsername.get('bob').teacher_id;

  await call('PUT', `/api/admin/teachers/${id}`, { password: 'bob-new-password' }, adminToken);

  assert.equal((await call('GET', '/api/admin/session', null, token)).status, 401);
  bob = (await call('POST', '/api/teacher/login',
    { username: 'bob', password: 'bob-new-password' })).data.token;
  assert.ok(bob);
});

test('deleting a teacher keeps their exams and every result', async () => {
  const before = await call('GET', `/api/admin/results/${bobQuiz}`, null, adminToken);
  const id = q.teacherByUsername.get('bob').teacher_id;

  const gone = await call('DELETE', `/api/admin/teachers/${id}`, null, adminToken);
  assert.equal(gone.status, 200);

  assert.equal((await call('GET', '/api/admin/session', null, bob)).status, 401);

  const after = await call('GET', `/api/admin/results/${bobQuiz}`, null, adminToken);
  assert.equal(after.status, 200, 'losing a term of results because staff left is indefensible');
  assert.equal(after.data.results.length, before.data.results.length);
  assert.equal(q.getQuiz.get(bobQuiz).owner_id, null, 'the exam falls to the administrator');
});

test('duplicate usernames and weak passwords are refused', async () => {
  const dupe = await call('POST', '/api/admin/teachers',
    { username: 'alice', displayName: 'Impostor', password: 'another-password' }, adminToken);
  assert.equal(dupe.status, 409);

  const weak = await call('POST', '/api/admin/teachers',
    { username: 'dave', displayName: 'Dave', password: 'x' }, adminToken);
  assert.equal(weak.status, 400);

  const obvious = await call('POST', '/api/admin/teachers',
    { username: 'erin', displayName: 'Erin', password: 'teacher' }, adminToken);
  assert.equal(obvious.status, 400);

  const badName = await call('POST', '/api/admin/teachers',
    { username: 'no spaces allowed', displayName: 'X', password: 'fine-password' }, adminToken);
  assert.equal(badName.status, 400);
});
