'use strict';

/**
 * Results are released manually by the examiner. No student-facing response may
 * disclose a mark — hiding it in the UI is not enough, because anyone with
 * devtools can read the raw payload.
 *
 * This sweeps every channel a student can reach and asserts the absence of any
 * scoring field, while confirming the invigilator still sees the real marks.
 */

process.env.DB_FILE = ':memory:';
process.env.ADMIN_PASSWORD = 'priv-pass';
process.env.PORT = process.env.TEST_PORT_PRIV || '38624';
process.env.QUIET = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const { server } = require('../server');
const BASE = `http://127.0.0.1:${process.env.PORT}`;

// Anything that could disclose a mark.
const SCORING_KEYS = ['score', 'correct', 'correct_count', 'total_questions',
  'answers_json', 'correct_option'];

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
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
}

/** Walks a payload and fails on any scoring key, at any depth. */
function assertNoScoring(payload, label) {
  const seen = [];
  (function walk(node, path) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (SCORING_KEYS.includes(key)) seen.push(`${path}.${key} = ${JSON.stringify(value)}`);
      walk(value, `${path}.${key}`);
    }
  }(payload, label));

  assert.deepEqual(seen, [], `${label} leaked scoring data: ${seen.join(', ')}`);
}

test.before(async () => {
  if (!server.listening) await once(server, 'listening');

  adminToken = (await call('POST', '/api/admin/login', { password: 'priv-pass' })).data.token;
  const created = await call('POST', '/api/admin/quizzes', {
    title: 'Privacy Exam',
    durationMinutes: 30,
    shuffleQuestions: false,
    questions: [
      { question_text: 'Q1', options: ['a', 'b', 'c', 'd'], correct_option: 0 },
      { question_text: 'Q2', options: ['a', 'b', 'c', 'd'], correct_option: 1 },
      { question_text: 'Q3', options: ['a', 'b', 'c', 'd'], correct_option: 2 },
      { question_text: 'Q4', options: ['a', 'b', 'c', 'd'], correct_option: 3 },
    ],
  }, adminToken);
  quizId = created.data.quiz.quiz_id;
  await call('POST', `/api/admin/quizzes/${quizId}/activate`, { active: true }, adminToken);
});

test.after(() => { server.close(); });

/* ------------------------------------------------------------------ */

test('no student-facing endpoint discloses a mark', async () => {
  const login = await call('POST', '/api/auth/login', { studentId: 'PRV-1', name: 'Priya One' });
  assertNoScoring(login.data, 'login');

  const token = login.data.token;
  const exam = await call('GET', '/api/quiz/exam', null, token);
  assertNoScoring(exam.data, 'exam payload');

  const ids = exam.data.questions.map((q) => q.question_id);
  const answers = {};
  ids.forEach((id, i) => { answers[`q${id}`] = i; }); // all four correct

  const progress = await call('POST', '/api/quiz/progress', { answers }, token);
  assertNoScoring(progress.data, 'progress');

  const submit = await call('POST', '/api/quiz/submit', { answers }, token);
  assert.equal(submit.data.result.status, 'SUBMITTED');
  assertNoScoring(submit.data, 'submit response');

  // The mark exists and is right - the student simply is not told it.
  const results = await call('GET', `/api/admin/results/${quizId}`, null, adminToken);
  const row = results.data.results.find((r) => r.studentId === 'PRV-1');
  assert.equal(row.score, 100);
  assert.equal(row.correct, 4);
});

test('an auto-terminated student is not told their mark', async () => {
  const login = await call('POST', '/api/auth/login', { studentId: 'PRV-2', name: 'Pat Two' });
  const exam = await call('GET', '/api/quiz/exam', null, login.data.token);

  const answers = {};
  answers[`q${exam.data.questions[0].question_id}`] = 0; // correct

  const res = await call('POST', '/api/quiz/flag-submit',
    { answers, reason: 'Tab switch or minimized' }, login.data.token);

  assert.equal(res.data.result.status, 'TERMINATED');
  assert.equal(res.data.result.reason, 'Tab switch or minimized');
  assertNoScoring(res.data, 'flag-submit response');

  const results = await call('GET', `/api/admin/results/${quizId}`, null, adminToken);
  const row = results.data.results.find((r) => r.studentId === 'PRV-2');
  assert.equal(row.correct, 1);
  assert.equal(row.score, 25);
});

test('a student cannot reach the admin results endpoints to look themselves up', async () => {
  const login = await call('POST', '/api/auth/login', { studentId: 'PRV-3', name: 'Pia Three' });
  const token = login.data.token;

  // An exam token is not an admin token, however it is presented.
  for (const path of [
    `/api/admin/results/${quizId}`,
    `/api/admin/monitor/${quizId}`,
    `/api/admin/quizzes/${quizId}`,
  ]) {
    const res = await call('GET', path, null, token);
    assert.equal(res.status, 401, `${path} must reject an exam token`);
  }

  const csv = await fetch(`${BASE}/api/admin/results/${quizId}/export.csv`
    + `?adminToken=${encodeURIComponent(token)}`);
  assert.equal(csv.status, 401, 'the CSV export must reject an exam token');
});

test('the student result screen has no score element left in the markup', async () => {
  const html = await (await fetch(`${BASE}/exam`)).text();
  const js = await (await fetch(`${BASE}/js/exam.js`)).text();

  assert.ok(!/id="resultScore"/.test(html), 'the score element must be gone from exam.html');
  assert.ok(/id="resultPending"/.test(html), 'the "results released later" notice must be present');
  assert.ok(!/result\.score|result\.correct/.test(js),
    'exam.js must not read a score off the response');
});

test('the mark still reaches the invigilator everywhere it should', async () => {
  const monitor = await call('GET', `/api/admin/monitor/${quizId}`, null, adminToken);
  const watched = monitor.data.students.find((s) => s.studentId === 'PRV-1');
  assert.equal(watched.score, 100);

  const csv = await fetch(`${BASE}/api/admin/results/${quizId}/export.csv`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const text = await csv.text();
  assert.match(text, /PRV-1,Priya One,SUBMITTED,100/);
  assert.match(text, /PRV-2,Pat Two,TERMINATED,25/);
});
