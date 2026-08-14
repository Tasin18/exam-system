'use strict';

/**
 * Duplicating a quiz.
 *
 * The interesting parts are what must NOT come across: the active flag (copying
 * a live exam must not knock it offline) and the attempts (a copy is a fresh
 * sitting, so single-attempt enforcement has to start clean).
 */

process.env.DB_FILE = ':memory:';
process.env.ADMIN_PASSWORD = 'dup-pass';
process.env.PORT = process.env.TEST_PORT_DUP || '38629';
process.env.QUIET = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const { server } = require('../server');
const BASE = `http://127.0.0.1:${process.env.PORT}`;

const PNG_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'
  + 'AAAADUlEQVR42mPz8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let adminToken;

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

const admin = (method, path, body) => call(method, path, body, adminToken);

async function makeQuiz(title, extra = {}) {
  const res = await admin('POST', '/api/admin/quizzes', {
    title,
    durationMinutes: 45,
    shuffleQuestions: false,
    questions: [
      { question_text: 'Capital of France?', options: ['Paris', 'Rome', 'Bonn', 'Oslo'], correct_option: 0 },
      { question_text: 'Two plus two?', options: ['3', '4', '5', '6'], correct_option: 1 },
      { question_text: 'Largest planet?', options: ['Mars', 'Earth', 'Jupiter', 'Venus'], correct_option: 2 },
    ],
    ...extra,
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data.quiz.quiz_id;
}

test.before(async () => {
  if (!server.listening) await once(server, 'listening');
  adminToken = (await call('POST', '/api/admin/login', { password: 'dup-pass' })).data.token;
});

test.after(() => { server.close(); });

/* ---------------- the copy itself ---------------- */

test('a duplicate carries the questions, answer key and settings across', async () => {
  const sourceId = await makeQuiz('Algorithms Midterm');

  const res = await admin('POST', `/api/admin/quizzes/${sourceId}/duplicate`);
  assert.equal(res.status, 201);
  assert.equal(res.data.copiedQuestions, 3);
  assert.equal(res.data.copiedFrom, sourceId);

  const copyId = res.data.quiz.quiz_id;
  assert.notEqual(copyId, sourceId, 'a duplicate must be a new quiz, not the same one');

  const source = (await admin('GET', `/api/admin/quizzes/${sourceId}`)).data;
  const copy = (await admin('GET', `/api/admin/quizzes/${copyId}`)).data;

  assert.equal(copy.quiz.duration_minutes, source.quiz.duration_minutes);
  assert.equal(copy.quiz.shuffle_questions, source.quiz.shuffle_questions);
  assert.equal(copy.questions.length, 3);

  // Same text, same options, same answer key - in the same order.
  copy.questions.forEach((question, i) => {
    assert.equal(question.question_text, source.questions[i].question_text);
    assert.deepEqual(question.options, source.questions[i].options);
    assert.equal(question.correct_option, source.questions[i].correct_option);
    assert.notEqual(question.question_id, source.questions[i].question_id,
      'copied questions must be new rows, or editing one would edit both');
  });
});

test('the shuffle setting is copied, not reset to the default', async () => {
  // createQuiz defaults shuffleQuestions to true, so a source with it OFF is
  // the case that catches a copy that silently re-enables it.
  const sourceId = await makeQuiz('Fixed Order Paper', { shuffleQuestions: false });
  const copyId = (await admin('POST', `/api/admin/quizzes/${sourceId}/duplicate`)).data.quiz.quiz_id;

  const copy = (await admin('GET', `/api/admin/quizzes/${copyId}`)).data;
  assert.equal(copy.quiz.shuffle_questions, false);

  const shuffledId = await makeQuiz('Shuffled Paper', { shuffleQuestions: true });
  const shuffledCopy = (await admin('POST',
    `/api/admin/quizzes/${shuffledId}/duplicate`)).data.quiz.quiz_id;
  assert.equal((await admin('GET', `/api/admin/quizzes/${shuffledCopy}`)).data.quiz.shuffle_questions,
    true);
});

test('question images are copied too', async () => {
  const res = await admin('POST', '/api/admin/quizzes', {
    title: 'Diagram Paper',
    durationMinutes: 30,
    questions: [
      { question_text: 'Identify this', options: ['a', 'b', 'c', 'd'], correct_option: 0, image: PNG_URI },
      { question_text: 'No picture here', options: ['a', 'b', 'c', 'd'], correct_option: 1 },
    ],
  });
  const sourceId = res.data.quiz.quiz_id;

  const dup = await admin('POST', `/api/admin/quizzes/${sourceId}/duplicate`);
  assert.equal(dup.data.copiedImages, 1);

  const copy = (await admin('GET', `/api/admin/quizzes/${dup.data.quiz.quiz_id}`)).data;
  assert.equal(copy.questions[0].has_image, true);
  assert.equal(copy.questions[1].has_image, false);

  // The copied blob must actually be servable, not just flagged.
  const image = await fetch(`${BASE}/api/quiz/image/${copy.questions[0].question_id}`,
    { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(image.status, 200);
  assert.ok(Number(image.headers.get('content-length')) > 0, 'copied image must have bytes');
});

/* ---------------- what must NOT be copied ---------------- */

test('duplicating the ACTIVE quiz does not knock the running exam offline', async () => {
  const liveId = await makeQuiz('Live Final');
  await admin('POST', `/api/admin/quizzes/${liveId}/activate`, { active: true });

  const copyId = (await admin('POST', `/api/admin/quizzes/${liveId}/duplicate`)).data.quiz.quiz_id;

  // Only one quiz may be active at a time, so an inherited flag would have
  // deactivated the exam students are sitting right now.
  const copy = (await admin('GET', `/api/admin/quizzes/${copyId}`)).data.quiz;
  assert.equal(copy.is_active, false, 'a copy must always be created inactive');

  const live = (await admin('GET', `/api/admin/quizzes/${liveId}`)).data.quiz;
  assert.equal(live.is_active, true, 'the original must still be the active exam');

  // And students still reach the original, not the copy.
  const active = await call('GET', '/api/quiz/active');
  assert.equal(active.data.quizId, liveId);
});

test('attempts are not copied, so everyone may sit the duplicate once', async () => {
  const sourceId = await makeQuiz('Retake Source');
  await admin('POST', `/api/admin/quizzes/${sourceId}/activate`, { active: true });

  // A student sits and submits the original.
  const login = await call('POST', '/api/auth/login', { studentId: 'DUP-1', name: 'Dup One' });
  await call('POST', '/api/quiz/submit', { answers: {} }, login.data.token);

  const blocked = await call('POST', '/api/auth/login', { studentId: 'DUP-1', name: 'Dup One' });
  assert.equal(blocked.status, 403, 'the original is single-attempt, as always');

  // Duplicate it and make the copy the live exam.
  const copyId = (await admin('POST', `/api/admin/quizzes/${sourceId}/duplicate`)).data.quiz.quiz_id;
  const results = await admin('GET', `/api/admin/results/${copyId}`);
  assert.equal(results.data.results.length, 0, 'a copy must start with no results');

  await admin('POST', `/api/admin/quizzes/${copyId}/activate`, { active: true });
  const fresh = await call('POST', '/api/auth/login', { studentId: 'DUP-1', name: 'Dup One' });
  assert.equal(fresh.status, 200,
    'the same student must be able to sit the copy - it is a different quiz');

  await admin('POST', `/api/admin/quizzes/${copyId}/activate`, { active: false });
});

test('editing the copy leaves the original untouched', async () => {
  const sourceId = await makeQuiz('Independent Source');
  const copyId = (await admin('POST', `/api/admin/quizzes/${sourceId}/duplicate`)).data.quiz.quiz_id;

  await admin('PUT', `/api/admin/quizzes/${copyId}`, {
    title: 'Rewritten',
    questions: [{ question_text: 'Only one now', options: ['a', 'b', 'c', 'd'], correct_option: 3 }],
  });

  const source = (await admin('GET', `/api/admin/quizzes/${sourceId}`)).data;
  assert.equal(source.questions.length, 3, 'the original must keep all its questions');
  assert.equal(source.quiz.title, 'Independent Source');
  assert.equal(source.questions[0].question_text, 'Capital of France?');
});

/* ---------------- naming ---------------- */

test('copies are named predictably and do not stack suffixes', async () => {
  const sourceId = await makeQuiz('Physics Paper');

  const first = (await admin('POST', `/api/admin/quizzes/${sourceId}/duplicate`)).data.quiz;
  assert.equal(first.title, 'Physics Paper (Copy)');

  const second = (await admin('POST', `/api/admin/quizzes/${sourceId}/duplicate`)).data.quiz;
  assert.equal(second.title, 'Physics Paper (Copy 2)');

  // Copying a copy must not give "(Copy) (Copy)".
  const third = (await admin('POST', `/api/admin/quizzes/${first.quiz_id}/duplicate`)).data.quiz;
  assert.equal(third.title, 'Physics Paper (Copy 3)');
});

test('an explicit title overrides the generated one', async () => {
  const sourceId = await makeQuiz('Term One Paper');
  const copy = (await admin('POST', `/api/admin/quizzes/${sourceId}/duplicate`,
    { title: '  Term Two Paper  ' })).data.quiz;
  assert.equal(copy.title, 'Term Two Paper', 'the title must be trimmed and used verbatim');
});

/* ---------------- guards ---------------- */

test('duplicating requires admin auth and a quiz that exists', async () => {
  const sourceId = await makeQuiz('Guarded Paper');

  const noAuth = await call('POST', `/api/admin/quizzes/${sourceId}/duplicate`);
  assert.equal(noAuth.status, 401);

  const missing = await admin('POST', '/api/admin/quizzes/999999/duplicate');
  assert.equal(missing.status, 404);

  const notANumber = await admin('POST', '/api/admin/quizzes/abc/duplicate');
  assert.equal(notANumber.status, 404);
});

test('the copy appears in the admin list, ready to activate', async () => {
  // What the invigilator actually sees after clicking Duplicate.
  const sourceId = await makeQuiz('Listed Paper');
  const copyId = (await admin('POST', `/api/admin/quizzes/${sourceId}/duplicate`)).data.quiz.quiz_id;

  const list = (await admin('GET', '/api/admin/quizzes')).data.quizzes;
  const row = list.find((z) => z.quiz_id === copyId);
  assert.ok(row, 'the copy must show up in the quiz list');
  assert.equal(row.question_count, 3, 'with its questions counted');
  assert.equal(row.is_active, false);

  // A quiz with no questions cannot be activated, so this proves the copy is a
  // complete, usable exam rather than an empty shell.
  const activated = await admin('POST', `/api/admin/quizzes/${copyId}/activate`, { active: true });
  assert.equal(activated.status, 200);
  assert.equal(activated.data.quiz.is_active, true);
  await admin('POST', `/api/admin/quizzes/${copyId}/activate`, { active: false });
});
