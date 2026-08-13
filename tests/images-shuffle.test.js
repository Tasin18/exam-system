'use strict';

/**
 * Question images and per-student question randomization.
 */

process.env.DB_FILE = ':memory:';
process.env.ADMIN_PASSWORD = 'img-pass';
process.env.PORT = process.env.TEST_PORT_IMG || '38623';
process.env.QUIET = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const { server } = require('../server');
const BASE = `http://127.0.0.1:${process.env.PORT}`;

// Smallest valid images, so the fixtures stay inline.
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8'
  + 'z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_URI = `data:image/png;base64,${PNG_1PX}`;
const GIF_URI = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

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

function makeQuestions(count, withImageOn = []) {
  return Array.from({ length: count }, (_, i) => ({
    question_text: `Question number ${i + 1}`,
    options: ['a', 'b', 'c', 'd'],
    correct_option: i % 4,
    image: withImageOn.includes(i) ? PNG_URI : null,
  }));
}

test.before(async () => {
  if (!server.listening) await once(server, 'listening');
  adminToken = (await call('POST', '/api/admin/login', { password: 'img-pass' })).data.token;
});

test.after(() => { server.close(); });

/* ============================ Images ============================ */

test('a quiz can be created with images on some questions', async () => {
  const created = await call('POST', '/api/admin/quizzes', {
    title: 'Image Exam',
    durationMinutes: 30,
    shuffleQuestions: false,
    questions: [
      { question_text: 'What does this diagram show?', options: ['a', 'b', 'c', 'd'], correct_option: 0, image: PNG_URI },
      { question_text: 'No image here', options: ['a', 'b', 'c', 'd'], correct_option: 1 },
      { question_text: 'A GIF one', options: ['a', 'b', 'c', 'd'], correct_option: 2, image: GIF_URI },
    ],
  }, adminToken);

  assert.equal(created.status, 201);
  quizId = created.data.quiz.quiz_id;
  await call('POST', `/api/admin/quizzes/${quizId}/activate`, { active: true }, adminToken);
});

test('the student payload flags images but never inlines the blob', async () => {
  const login = await call('POST', '/api/auth/login', { studentId: 'IMG-001', name: 'Ima Jones' });
  const exam = await call('GET', '/api/quiz/exam', null, login.data.token);

  assert.equal(exam.status, 200);
  assert.deepEqual(exam.data.questions.map((q) => q.has_image), [true, false, true]);

  // The payload must stay small - no base64 blob smuggled into the JSON.
  const raw = JSON.stringify(exam.data);
  assert.ok(!raw.includes('base64'), 'image bytes must not be inlined in the exam payload');
  assert.ok(!raw.includes(PNG_1PX.slice(0, 32)));

  globalThis.__imgStudent = login.data.token;
  globalThis.__imgQuestions = exam.data.questions;
});

test('a student can fetch an image for their own exam', async () => {
  const question = globalThis.__imgQuestions.find((q) => q.has_image);
  const res = await fetch(`${BASE}/api/quiz/image/${question.question_id}`
    + `?t=${encodeURIComponent(globalThis.__imgStudent)}`);

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');

  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(bytes, Buffer.from(PNG_1PX, 'base64'), 'bytes round-trip unchanged');
});

test('image requests without a valid token are refused', async () => {
  const question = globalThis.__imgQuestions.find((q) => q.has_image);

  const noToken = await fetch(`${BASE}/api/quiz/image/${question.question_id}`);
  assert.equal(noToken.status, 401);

  const badToken = await fetch(`${BASE}/api/quiz/image/${question.question_id}?t=nope`);
  assert.equal(badToken.status, 401);
});

test('a question without an image 404s', async () => {
  const question = globalThis.__imgQuestions.find((q) => !q.has_image);
  const res = await fetch(`${BASE}/api/quiz/image/${question.question_id}`
    + `?t=${encodeURIComponent(globalThis.__imgStudent)}`);
  assert.equal(res.status, 404);
});

test('a student cannot read images belonging to a different quiz', async () => {
  const other = await call('POST', '/api/admin/quizzes', {
    title: 'Other Exam', durationMinutes: 10,
    questions: [{ question_text: 'Secret', options: ['a', 'b'], correct_option: 0, image: PNG_URI }],
  }, adminToken);
  const otherQuizId = other.data.quiz.quiz_id;

  const detail = await call('GET', `/api/admin/quizzes/${otherQuizId}`, null, adminToken);
  const foreignId = detail.data.questions[0].question_id;

  const res = await fetch(`${BASE}/api/quiz/image/${foreignId}`
    + `?t=${encodeURIComponent(globalThis.__imgStudent)}`);
  assert.equal(res.status, 403);

  // An admin may read it.
  const asAdmin = await fetch(`${BASE}/api/quiz/image/${foreignId}?adminToken=${adminToken}`);
  assert.equal(asAdmin.status, 200);
});

test('the admin editor gets images back as data URIs so edits round-trip', async () => {
  // Close the outstanding attempt: editing questions is refused mid-exam.
  await call('POST', '/api/quiz/submit', { answers: {} }, globalThis.__imgStudent);

  const detail = await call('GET', `/api/admin/quizzes/${quizId}`, null, adminToken);
  assert.equal(detail.data.questions[0].image, PNG_URI);
  assert.equal(detail.data.questions[1].image, undefined);
  assert.equal(detail.data.questions[2].image, GIF_URI);

  // Re-saving the payload unchanged must preserve the images.
  const resave = await call('PUT', `/api/admin/quizzes/${quizId}`, {
    questions: detail.data.questions.map((q) => ({
      question_text: q.question_text,
      options: q.options,
      correct_option: q.correct_option,
      image: q.image || null,
    })),
  }, adminToken);
  assert.equal(resave.status, 200);

  const after = await call('GET', `/api/admin/quizzes/${quizId}`, null, adminToken);
  assert.equal(after.data.questions[0].image, PNG_URI);
  assert.equal(after.data.questions[2].image, GIF_URI);
});

test('an image can be removed by saving the question without one', async () => {
  const detail = await call('GET', `/api/admin/quizzes/${quizId}`, null, adminToken);
  const stripped = detail.data.questions.map((q) => ({
    question_text: q.question_text,
    options: q.options,
    correct_option: q.correct_option,
    image: null,
  }));
  await call('PUT', `/api/admin/quizzes/${quizId}`, { questions: stripped }, adminToken);

  const after = await call('GET', `/api/admin/quizzes/${quizId}`, null, adminToken);
  assert.ok(after.data.questions.every((q) => !q.image && !q.has_image));
});

test('malformed and disallowed images are rejected', async () => {
  const cases = [
    ['not a data uri', 'just-a-string'],
    ['SVG (can carry script)', 'data:image/svg+xml;base64,PHN2Zy8+'],
    ['non-image mime', 'data:application/pdf;base64,JVBERi0='],
    ['empty payload', 'data:image/png;base64,'],
  ];

  for (const [label, image] of cases) {
    const res = await call('POST', '/api/admin/quizzes', {
      title: `Bad ${label}`, durationMinutes: 10,
      questions: [{ question_text: 'Q', options: ['a', 'b'], correct_option: 0, image }],
    }, adminToken);
    assert.equal(res.status, 400, `${label} should be rejected`);
  }
});

test('an oversized image is rejected with a helpful message', async () => {
  const huge = `data:image/png;base64,${Buffer.alloc(4 * 1024 * 1024, 1).toString('base64')}`;
  const res = await call('POST', '/api/admin/quizzes', {
    title: 'Huge', durationMinutes: 10,
    questions: [{ question_text: 'Q', options: ['a', 'b'], correct_option: 0, image: huge }],
  }, adminToken);

  assert.equal(res.status, 400);
  assert.match(res.data.error, /limit is 3 MB/);
});

/* ========================== Randomization ========================== */

test('question order differs between students but is stable per student', async () => {
  const created = await call('POST', '/api/admin/quizzes', {
    title: 'Shuffled Exam',
    durationMinutes: 30,
    shuffleQuestions: true,
    questions: makeQuestions(12),
  }, adminToken);
  const shuffledQuizId = created.data.quiz.quiz_id;
  await call('POST', `/api/admin/quizzes/${shuffledQuizId}/activate`, { active: true }, adminToken);

  const orders = [];
  const tokens = [];

  for (let i = 0; i < 8; i += 1) {
    const login = await call('POST', '/api/auth/login',
      { studentId: `SHF-${i}`, name: `Student ${i}` });
    const exam = await call('GET', '/api/quiz/exam', null, login.data.token);
    orders.push(exam.data.questions.map((q) => q.question_id));
    tokens.push(login.data.token);
  }

  // Every student sees all 12 questions, exactly once.
  const canonical = orders[0].slice().sort((a, b) => a - b);
  for (const order of orders) {
    assert.equal(order.length, 12);
    assert.deepEqual(order.slice().sort((a, b) => a - b), canonical,
      'every student must get the full question set');
  }

  // Orders must actually differ across students.
  const distinct = new Set(orders.map((o) => o.join(',')));
  assert.ok(distinct.size > 1,
    `expected differing orders across students, got ${distinct.size} distinct`);

  // At least one student's order differs from the stored order.
  assert.ok(orders.some((o) => o.join(',') !== canonical.join(',')),
    'at least one student should not see the authored order');

  // Re-fetching must return the SAME order - a reload cannot reshuffle, or
  // saved answers would appear against the wrong questions.
  for (let i = 0; i < tokens.length; i += 1) {
    const again = await call('GET', '/api/quiz/exam', null, tokens[i]);
    assert.deepEqual(again.data.questions.map((q) => q.question_id), orders[i],
      'reload must preserve the order');
  }

  globalThis.__shuffledQuizId = shuffledQuizId;
});

test('resuming after a disconnect keeps the same question order', async () => {
  const quiz = globalThis.__shuffledQuizId;
  const first = await call('POST', '/api/auth/login', { studentId: 'SHF-R', name: 'Resumer' });
  const before = (await call('GET', '/api/quiz/exam', null, first.data.token))
    .data.questions.map((q) => q.question_id);

  // Log in again, as a student would after their browser crashed.
  const second = await call('POST', '/api/auth/login', { studentId: 'SHF-R', name: 'Resumer' });
  assert.equal(second.data.resumed, true);
  const after = (await call('GET', '/api/quiz/exam', null, second.data.token))
    .data.questions.map((q) => q.question_id);

  assert.deepEqual(after, before);
  void quiz;
});

test('shuffling does not affect grading - answers are keyed by question id', async () => {
  const login = await call('POST', '/api/auth/login', { studentId: 'SHF-G', name: 'Grade Me' });
  const exam = await call('GET', '/api/quiz/exam', null, login.data.token);

  // Answer every question correctly. correct_option is i % 4 by construction,
  // and the authored index is recoverable from the question text.
  const answers = {};
  for (const question of exam.data.questions) {
    const authored = Number(/Question number (\d+)/.exec(question.question_text)[1]) - 1;
    answers[`q${question.question_id}`] = authored % 4;
  }

  const res = await call('POST', '/api/quiz/submit', { answers }, login.data.token);
  assert.equal(res.data.result.status, 'SUBMITTED');
  assert.equal(res.data.result.score, undefined, 'the student is not told their mark');

  // Verified through the admin view, where the mark is visible.
  const results = await call('GET',
    `/api/admin/results/${globalThis.__shuffledQuizId}`, null, adminToken);
  const row = results.data.results.find((r) => r.studentId === 'SHF-G');
  assert.equal(row.score, 100);
  assert.equal(row.correct, 12);
});

test('a quiz with shuffling off serves the authored order to everyone', async () => {
  const created = await call('POST', '/api/admin/quizzes', {
    title: 'Fixed Order Exam',
    durationMinutes: 30,
    shuffleQuestions: false,
    questions: makeQuestions(10),
  }, adminToken);
  const fixedQuizId = created.data.quiz.quiz_id;
  await call('POST', `/api/admin/quizzes/${fixedQuizId}/activate`, { active: true }, adminToken);

  const seen = [];
  for (let i = 0; i < 4; i += 1) {
    const login = await call('POST', '/api/auth/login',
      { studentId: `FIX-${i}`, name: `Fixed ${i}` });
    const exam = await call('GET', '/api/quiz/exam', null, login.data.token);
    seen.push(exam.data.questions.map((q) => q.question_text));
  }

  const authored = makeQuestions(10).map((q) => q.question_text);
  for (const order of seen) assert.deepEqual(order, authored);
});

test('shuffleQuestions defaults to on and survives activation', async () => {
  const created = await call('POST', '/api/admin/quizzes', {
    title: 'Default Shuffle', durationMinutes: 10,
    questions: makeQuestions(3),
  }, adminToken);
  assert.equal(created.data.quiz.shuffle_questions, true);

  const quizIdLocal = created.data.quiz.quiz_id;
  // Activating and deactivating must not silently reset the flag.
  await call('POST', `/api/admin/quizzes/${quizIdLocal}/activate`, { active: true }, adminToken);
  await call('POST', `/api/admin/quizzes/${quizIdLocal}/activate`, { active: false }, adminToken);

  const detail = await call('GET', `/api/admin/quizzes/${quizIdLocal}`, null, adminToken);
  assert.equal(detail.data.quiz.shuffle_questions, true);

  const off = await call('PUT', `/api/admin/quizzes/${quizIdLocal}`,
    { shuffleQuestions: false }, adminToken);
  assert.equal(off.data.quiz.shuffle_questions, false);

  await call('POST', `/api/admin/quizzes/${quizIdLocal}/activate`, { active: true }, adminToken);
  const after = await call('GET', `/api/admin/quizzes/${quizIdLocal}`, null, adminToken);
  assert.equal(after.data.quiz.shuffle_questions, false, 'activation must not flip the flag');
});

test('the seeded shuffle is deterministic and a real permutation', () => {
  const svc = require('../src/service');
  const items = Array.from({ length: 50 }, (_, i) => i);

  const a = svc.shuffleWithSeed(items, 12345);
  const b = svc.shuffleWithSeed(items, 12345);
  const c = svc.shuffleWithSeed(items, 999);

  assert.deepEqual(a, b, 'same seed must give the same order');
  assert.notDeepEqual(a, c, 'different seeds should give different orders');
  assert.deepEqual(a.slice().sort((x, y) => x - y), items, 'must be a permutation');
  assert.deepEqual(items, Array.from({ length: 50 }, (_, i) => i), 'input must not be mutated');
});
