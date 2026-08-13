'use strict';

/**
 * Real-time invigilation checks: presence, live snapshots, the flag_and_submit
 * violation path, and the guarantee that student sockets cannot read admin data.
 */

process.env.DB_FILE = ':memory:';
process.env.ADMIN_PASSWORD = 'rt-pass';
process.env.PORT = process.env.TEST_PORT_RT || '38622';
process.env.QUIET = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { io: ioClient } = require('socket.io-client');

const { server } = require('../server');
const BASE = `http://127.0.0.1:${process.env.PORT}`;

const sockets = [];

function connect() {
  const socket = ioClient(BASE, { transports: ['websocket'], forceNew: true });
  sockets.push(socket);
  return socket;
}

/** Promise wrapper around an emit that expects an ack. */
function emitAck(socket, event, payload, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ack for ${event}`)), timeoutMs);
    socket.emit(event, payload, (ack) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

function waitFor(socket, event, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** Waits for a snapshot that satisfies `predicate`, ignoring earlier ones. */
function waitForSnapshot(socket, predicate, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('admin:snapshot', handler);
      reject(new Error('timed out waiting for a matching admin:snapshot'));
    }, timeoutMs);
    const handler = (snapshot) => {
      if (!predicate(snapshot)) return;
      clearTimeout(timer);
      socket.off('admin:snapshot', handler);
      resolve(snapshot);
    };
    socket.on('admin:snapshot', handler);
  });
}

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
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
}

let adminToken;
let quizId;

test.before(async () => {
  if (!server.listening) await once(server, 'listening');

  adminToken = (await call('POST', '/api/admin/login', { password: 'rt-pass' })).data.token;
  const created = await call('POST', '/api/admin/quizzes', {
    title: 'Realtime Exam',
    durationMinutes: 20,
    questions: [
      { question_text: 'A?', options: ['1', '2'], correct_option: 0 },
      { question_text: 'B?', options: ['1', '2'], correct_option: 1 },
    ],
  }, adminToken);
  quizId = created.data.quiz.quiz_id;
  await call('POST', `/api/admin/quizzes/${quizId}/activate`, { active: true }, adminToken);
});

test.after(() => {
  sockets.forEach((socket) => socket.close());
  server.close();
});

/* ------------------------------------------------------------------ */

test('a student socket joins with a valid exam token', async () => {
  const login = await call('POST', '/api/auth/login', { studentId: 'RT-001', name: 'Rita One' });
  const socket = connect();
  await once(socket, 'connect');

  const ack = await emitAck(socket, 'student:join', { token: login.data.token });
  assert.equal(ack.ok, true);
  assert.equal(ack.studentId, 'RT-001');
  assert.equal(ack.quizId, quizId);

  globalThis.__rt1 = { socket, token: login.data.token };
});

test('a student socket is refused with a bad token', async () => {
  const socket = connect();
  await once(socket, 'connect');

  const invalid = waitFor(socket, 'session:invalid');
  const ack = await emitAck(socket, 'student:join', { token: 'not-a-real-token' });
  assert.equal(ack.ok, false);
  await invalid; // the client is told to drop its dead session
});

test('an admin socket is refused without the admin token', async () => {
  const socket = connect();
  await once(socket, 'connect');
  const ack = await emitAck(socket, 'admin:join', { token: 'wrong' });
  assert.equal(ack.ok, false);
  assert.match(ack.error, /authentication required/i);
});

test('an admin socket receives a live snapshot with the student shown online', async () => {
  const admin = connect();
  await once(admin, 'connect');

  const ack = await emitAck(admin, 'admin:join', { token: adminToken, quizId });
  assert.equal(ack.ok, true);

  const snapshot = await waitForSnapshot(admin, (s) => s.quiz.quiz_id === quizId);
  const student = snapshot.students.find((s) => s.studentId === 'RT-001');
  assert.ok(student, 'the joined student appears in the roster');
  assert.equal(student.display, 'IN_PROGRESS');
  assert.equal(student.online, true);
  assert.equal(snapshot.onlineCount, 1);

  globalThis.__admin = admin;
});

test('a student socket never receives admin snapshots', async () => {
  const { socket } = globalThis.__rt1;
  let leaked = null;
  socket.on('admin:snapshot', (payload) => { leaked = payload; });
  socket.on('admin:flag', (payload) => { leaked = payload; });

  // Force a broadcast (listener attached first, so the push can't be missed),
  // then confirm nothing reached the student socket.
  const pushed = waitForSnapshot(globalThis.__admin, (s) => s.quiz.quiz_id === quizId);
  globalThis.__admin.emit('admin:watch', { quizId });
  await pushed;

  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(leaked, null);
});

test('a warning-level flag reaches the admin without ending the exam', async () => {
  const { socket, token } = globalThis.__rt1;
  const admin = globalThis.__admin;

  const flagEvent = waitFor(admin, 'admin:flag');
  socket.emit('flag', { reason: 'Pointer left the exam window' });

  const event = await flagEvent;
  assert.equal(event.studentId, 'RT-001');
  assert.equal(event.severity, 'WARN');
  assert.match(event.reason, /Pointer left/);

  // Still in progress — a warning must not terminate the attempt.
  const exam = await call('GET', '/api/quiz/exam', null, token);
  assert.equal(exam.status, 200);
});

test('flag_and_submit terminates the attempt and notifies the admin', async () => {
  const { socket, token } = globalThis.__rt1;
  const admin = globalThis.__admin;

  const attemptEvent = waitFor(admin, 'admin:attempt');
  const terminated = waitFor(socket, 'exam:terminated');

  const ack = await emitAck(socket, 'flag_and_submit', {
    studentId: 'RT-001',
    reason: 'Exited fullscreen mode',
    answers: { q1: 0 },
  });

  assert.equal(ack.ok, true);
  assert.equal(ack.result.status, 'TERMINATED');
  assert.equal(ack.result.submissionType, 'AUTO_TERMINATED');
  assert.equal(ack.result.reason, 'Exited fullscreen mode');
  // Marks are released manually — never over the student socket.
  assert.equal(ack.result.score, undefined);
  assert.equal(ack.result.correct, undefined);

  const seen = await terminated;
  assert.equal(seen.result.score, undefined,
    'the exam:terminated event must not carry a mark');

  // The admin feed still carries the mark — only the student channel is blind.
  const event = await attemptEvent;
  assert.equal(event.studentId, 'RT-001');
  assert.equal(event.status, 'TERMINATED');
  assert.equal(typeof event.score, 'number');

  // The session token is cleared on finalize, so it no longer resolves at all.
  const dead = await call('GET', '/api/quiz/exam', null, token);
  assert.equal(dead.status, 401);

  const snapshot = await waitForSnapshot(admin,
    (s) => s.students.some((x) => x.studentId === 'RT-001' && x.display === 'AUTO_TERMINATED'));
  assert.ok(snapshot);
});

test('an admin reset tells the student client its session is gone', async () => {
  const login = await call('POST', '/api/auth/login', { studentId: 'RT-002', name: 'Ravi Two' });
  const socket = connect();
  await once(socket, 'connect');
  await emitAck(socket, 'student:join', { token: login.data.token });

  const invalidated = waitFor(socket, 'session:invalid');
  await call('POST', '/api/admin/reset-attempt', { studentId: 'RT-002', quizId }, adminToken);

  const payload = await invalidated;
  assert.match(payload.reason, /reset by the administrator/i);
});

test('presence clears when a student socket disconnects', async () => {
  const login = await call('POST', '/api/auth/login', { studentId: 'RT-003', name: 'Rosa Three' });
  const socket = connect();
  await once(socket, 'connect');
  await emitAck(socket, 'student:join', { token: login.data.token });

  const admin = globalThis.__admin;
  await waitForSnapshot(admin,
    (s) => s.students.some((x) => x.studentId === 'RT-003' && x.online === true));

  socket.close();

  const after = await waitForSnapshot(admin,
    (s) => s.students.some((x) => x.studentId === 'RT-003' && x.online === false));
  const student = after.students.find((x) => x.studentId === 'RT-003');
  // Still IN_PROGRESS — a dropped connection is not a submission.
  assert.equal(student.display, 'IN_PROGRESS');
  assert.equal(student.online, false);
});

test('heartbeat acks carry the server clock for drift correction', async () => {
  const login = await call('POST', '/api/auth/login', { studentId: 'RT-004', name: 'Remy Four' });
  const socket = connect();
  await once(socket, 'connect');
  await emitAck(socket, 'student:join', { token: login.data.token });

  const ackPromise = waitFor(socket, 'heartbeat:ack');
  socket.emit('heartbeat');
  const payload = await ackPromise;
  assert.equal(typeof payload.serverTime, 'number');
  assert.ok(Math.abs(payload.serverTime - Date.now()) < 10_000);
});

test('flag_and_submit from a socket that never joined is rejected', async () => {
  const socket = connect();
  await once(socket, 'connect');
  const ack = await emitAck(socket, 'flag_and_submit', { reason: 'spoofed' });
  assert.equal(ack.ok, false);
  assert.match(ack.error, /Not in an exam session/);
});
