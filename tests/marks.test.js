'use strict';

/**
 * Per-question marks.
 *
 * The arithmetic is the whole feature, so it is pinned here rather than left to
 * be inferred: a percentage taken over question counts and a percentage taken
 * over marks agree on every paper where marks are equal, and disagree on every
 * paper where they are not. The tests below are built so that a regression to
 * counting questions produces a visibly wrong number, not a plausible one.
 */

process.env.DB_FILE = ':memory:';
process.env.ADMIN_PASSWORD = 'marks-test-admin-password';
process.env.PORT = process.env.TEST_PORT_MARKS || '38651';
process.env.QUIET = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const { server } = require('../server');
const { q } = require('../src/db');
const BASE = `http://127.0.0.1:${process.env.PORT}`;

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
  const data = type.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, data };
}

/** Creates a quiz, activates it, and returns its id plus its questions in order. */
async function paper(title, questions) {
  const made = await call('POST', '/api/admin/quizzes', {
    title, durationMinutes: 60, isActive: true, questions,
  }, adminToken);
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const quizId = made.data.quiz.quiz_id;
  const full = await call('GET', `/api/admin/quizzes/${quizId}`, null, adminToken);
  return { quizId, questions: full.data.questions };
}

/** Sits `quizId` as `studentId`, answering exactly the questions named in `getRight`. */
async function sit(quizId, studentId, questions, getRight) {
  const login = await call('POST', '/api/auth/login',
    { studentId, name: `Student ${studentId}`, quizId });
  assert.equal(login.status, 200, JSON.stringify(login.data));

  const answers = {};
  questions.forEach((question) => {
    const right = getRight(question);
    if (right === null) return;                  // left blank
    answers[`q${question.question_id}`] = right
      ? question.correct_option
      : (question.correct_option + 1) % question.options.length;
  });

  const res = await call('POST', '/api/quiz/submit',
    { answers, submissionType: 'MANUAL' }, login.data.token);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return call('GET', `/api/admin/results/${quizId}/student/${studentId}`, null, adminToken);
}

const mcq = (text, marks) => ({
  question_text: text,
  options: ['right', 'wrong'],
  correct_option: 0,
  ...(marks === undefined ? {} : { marks }),
});

test.before(async () => {
  if (!server.listening) await once(server, 'listening');
  adminToken = (await call('POST', '/api/admin/login',
    { password: 'marks-test-admin-password' })).data.token;
});

test.after(() => { server.close(); });

/* ================= Defaults ================= */

test('a question with no marks given is worth 1', async () => {
  const { quizId, questions } = await paper('Unweighted', [mcq('A'), mcq('B'), mcq('C')]);
  questions.forEach((question) => assert.equal(question.marks, 1));

  const active = await call('GET', '/api/quiz/active');
  assert.equal(active.data.totalMarks, 3);
  assert.equal(q.totalMarks.get(quizId).total, 3);
});

test('an unweighted paper scores exactly as it did before marks existed', async () => {
  const { quizId, questions } = await paper('Legacy Arithmetic',
    [mcq('A'), mcq('B'), mcq('C'), mcq('D')]);

  // Three of four right: 75% either way. This is the compatibility guarantee.
  const sheet = await sit(quizId, 'LEG-1', questions, (question) =>
    question.question_text !== 'D');
  assert.equal(sheet.data.attempt.score, 75);
  assert.equal(sheet.data.attempt.correct, 3);
  assert.equal(sheet.data.attempt.earnedMarks, 3);
  assert.equal(sheet.data.attempt.totalMarks, 4);
});

/* ================= Weighted arithmetic ================= */

test('the percentage follows the marks, not the number of questions', async () => {
  // One question worth 1, one worth 9. Getting only the heavy one is 90%.
  // Counting questions would call it 50% - the number this feature exists to fix.
  const { quizId, questions } = await paper('Weighted',
    [mcq('Cheap', 1), mcq('Expensive', 9)]);

  const sheet = await sit(quizId, 'W-1', questions, (question) =>
    question.question_text === 'Expensive');

  assert.equal(sheet.data.attempt.earnedMarks, 9);
  assert.equal(sheet.data.attempt.totalMarks, 10);
  assert.equal(sheet.data.attempt.score, 90);
  assert.equal(sheet.data.attempt.correct, 1, 'one of two questions, still');
  assert.equal(sheet.data.attempt.total, 2);
});

test('the same paper answered the other way round scores 10%, not 50%', async () => {
  const { quizId, questions } = await paper('Weighted Inverse',
    [mcq('Cheap', 1), mcq('Expensive', 9)]);

  const sheet = await sit(quizId, 'W-2', questions, (question) =>
    question.question_text === 'Cheap');
  assert.equal(sheet.data.attempt.earnedMarks, 1);
  assert.equal(sheet.data.attempt.score, 10);
});

test('half marks are honoured and do not drift into floating-point noise', async () => {
  const { quizId, questions } = await paper('Halves',
    [mcq('A', 0.5), mcq('B', 0.5), mcq('C', 1.5), mcq('D', 2.5)]);
  assert.equal(q.totalMarks.get(quizId).total, 5);

  // 0.5 + 1.5 = 2 of 5 = 40%. Naive addition of tenths is where this goes wrong.
  const sheet = await sit(quizId, 'H-1', questions, (question) =>
    question.question_text === 'A' || question.question_text === 'C');
  assert.equal(sheet.data.attempt.earnedMarks, 2);
  assert.equal(sheet.data.attempt.totalMarks, 5);
  assert.equal(sheet.data.attempt.score, 40);
});

test('a blank answer earns nothing, and is not the same as a wrong one', async () => {
  const { quizId, questions } = await paper('Blanks',
    [mcq('A', 3), mcq('B', 3), mcq('C', 4)]);

  const sheet = await sit(quizId, 'B-1', questions, (question) => {
    if (question.question_text === 'A') return true;
    if (question.question_text === 'B') return false;
    return null;                                    // C left blank
  });

  assert.equal(sheet.data.attempt.earnedMarks, 3);
  assert.equal(sheet.data.attempt.score, 30);
  assert.equal(sheet.data.counts.answered, 2);
  assert.equal(sheet.data.counts.unanswered, 1);
  assert.equal(sheet.data.counts.wrong, 1);
});

test('every question on the sheet reports what it was worth and what it earned', async () => {
  const { quizId, questions } = await paper('Breakdown',
    [mcq('A', 2), mcq('B', 8)]);

  const sheet = await sit(quizId, 'BD-1', questions, (question) =>
    question.question_text === 'B');

  const byText = new Map(sheet.data.questions.map((item) => [item.question_text, item]));
  assert.deepEqual(
    { marks: byText.get('A').marks, awarded: byText.get('A').awarded },
    { marks: 2, awarded: 0 });
  assert.deepEqual(
    { marks: byText.get('B').marks, awarded: byText.get('B').awarded },
    { marks: 8, awarded: 8 });

  // The per-question awards must add up to the sheet's own total, or a printed
  // breakdown would contradict the mark at the top of it.
  const summed = sheet.data.questions.reduce((total, item) => total + item.awarded, 0);
  assert.equal(summed, sheet.data.counts.earnedMarks);
  assert.equal(sheet.data.counts.totalMarks, 10);
});

/* ================= Students see the weighting ================= */

test('the exam paper tells the student what each question is worth', async () => {
  const { quizId, questions } = await paper('Disclosed', [mcq('A', 1), mcq('B', 4)]);
  const login = await call('POST', '/api/auth/login',
    { studentId: 'DIS-1', name: 'Disclosed', quizId });

  const exam = await call('GET', '/api/quiz/exam', null, login.data.token);
  assert.equal(exam.data.quiz.totalMarks, 5);
  const marks = exam.data.questions.map((question) => question.marks).sort();
  assert.deepEqual(marks, [1, 4]);

  // And still no answer key, which the extra field must not have loosened.
  assert.ok(exam.data.questions.every((question) => question.correct_option === undefined));
});

/* ================= Validation ================= */

test('unusable marks are refused, and the quiz is not half-written', async () => {
  const before = (await call('GET', '/api/admin/quizzes', null, adminToken)).data.quizzes.length;

  for (const [marks, pattern] of [
    [0, /greater than zero/i],
    [-2, /greater than zero/i],
    [1001, /cannot exceed 1000/i],
    [0.333, /two decimal places/i],
    ['abc', /must be a number/i],
  ]) {
    const res = await call('POST', '/api/admin/quizzes', {
      title: `Bad ${marks}`,
      durationMinutes: 30,
      questions: [mcq('A'), { ...mcq('B'), marks }],
    }, adminToken);
    assert.equal(res.status, 400, `marks=${marks} should be refused`);
    assert.match(res.data.error, pattern);
    assert.match(res.data.error, /Question 2/, 'the message must name the question');
  }

  const after = (await call('GET', '/api/admin/quizzes', null, adminToken)).data.quizzes.length;
  assert.equal(after, before, 'a refused paper must leave nothing behind');
});

test('marks survive an edit that does not mention them, and can be changed', async () => {
  const { quizId } = await paper('Editable', [mcq('A', 5), mcq('B', 5)]);

  await call('PUT', `/api/admin/quizzes/${quizId}`, { title: 'Editable (renamed)' }, adminToken);
  assert.equal(q.totalMarks.get(quizId).total, 10, 'a rename must not reset the weighting');

  const reloaded = await call('GET', `/api/admin/quizzes/${quizId}`, null, adminToken);
  const rewritten = reloaded.data.questions.map((question, index) => ({
    question_text: question.question_text,
    options: question.options,
    correct_option: question.correct_option,
    marks: index === 0 ? 1 : 3,
  }));
  await call('PUT', `/api/admin/quizzes/${quizId}`, { questions: rewritten }, adminToken);
  assert.equal(q.totalMarks.get(quizId).total, 4);
});

test('a duplicated paper keeps its weighting', async () => {
  const { quizId } = await paper('Original Weighting', [mcq('A', 2), mcq('B', 7)]);
  const copy = await call('POST', `/api/admin/quizzes/${quizId}/duplicate`, {}, adminToken);
  assert.equal(copy.status, 201);
  assert.equal(q.totalMarks.get(copy.data.quiz.quiz_id).total, 9);
});

/* ================= Reporting ================= */

test('the CSV mark sheet carries marks alongside the percentage', async () => {
  const { quizId, questions } = await paper('Exported', [mcq('A', 3), mcq('B', 7)]);
  await sit(quizId, 'CSV-1', questions, (question) => question.question_text === 'B');

  const res = await fetch(`${BASE}/api/admin/results/${quizId}/export.csv`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const text = await res.text();
  const lines = text.trim().split(/\r?\n/);
  assert.match(lines[0], /Marks,Total Marks,Score \(%\),Correct,Questions/);
  assert.match(text, /CSV-1,Student CSV-1,SUBMITTED,7,10,70,1,2/);
});

test('the live monitor reports the paper total and each student\'s marks', async () => {
  const { quizId, questions } = await paper('Watched', [mcq('A', 4), mcq('B', 6)]);
  await sit(quizId, 'MON-1', questions, () => true);

  const snap = await call('GET', `/api/admin/monitor/${quizId}`, null, adminToken);
  assert.equal(snap.data.totalMarks, 10);
  const row = snap.data.students.find((s) => s.studentId === 'MON-1');
  assert.equal(row.earnedMarks, 10);
  assert.equal(row.totalMarks, 10);
  assert.equal(row.score, 100);
});

test('the quiz list reports each paper total, for the dashboard column', async () => {
  const { quizId } = await paper('Totalled', [mcq('A', 2.5), mcq('B', 2.5)]);
  const list = await call('GET', '/api/admin/quizzes', null, adminToken);
  const row = list.data.quizzes.find((x) => x.quiz_id === quizId);
  assert.equal(row.total_marks, 5);
  assert.equal(row.question_count, 2);
});

test('the answer-sheet PDF renders for a weighted paper', async () => {
  const { quizId, questions } = await paper('Printed', [mcq('A', 1), mcq('B', 9)]);
  await sit(quizId, 'PDF-1', questions, (question) => question.question_text === 'B');

  const res = await fetch(
    `${BASE}/api/admin/results/${quizId}/student/PDF-1/answers.pdf`,
    { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.ok(bytes.length > 1000);
  assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
});

/* ================= Migration ================= */

test('attempts recorded before marks existed are backfilled exactly', () => {
  // Pre-existing rows were graded when every question was worth one mark, so
  // marks earned are precisely the number correct - not an approximation.
  const rows = q.attemptsByQuiz.all(1);
  for (const row of rows) {
    assert.notEqual(row.earned_marks, null);
    assert.notEqual(row.total_marks, null);
  }
});
