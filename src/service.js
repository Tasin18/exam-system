'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { db, q, nowIso, mapQuiz, mapQuestion } = require('./db');

const reissueTokenStmt = db.prepare(
  "UPDATE attempts SET token = ? WHERE attempt_id = ? AND status = 'IN_PROGRESS'");

/**
 * Central exam logic. Both the REST routes and the Socket.io layer go through
 * here so an auto-submit arriving over a socket and one arriving over HTTP
 * follow exactly the same code path.
 */
const bus = new EventEmitter();

// Live presence: token -> { studentId, quizId, socketId, lastSeen }
const presence = new Map();

const SUBMISSION_TYPES = new Set([
  'MANUAL', 'AUTO_TERMINATED', 'TIME_EXPIRED', 'ADMIN_FORCED',
]);

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

const newToken = () => crypto.randomBytes(24).toString('hex');

/* ------------------------------------------------------------------ *
 * Quizzes
 * ------------------------------------------------------------------ */

function getActiveQuiz() {
  return mapQuiz(q.activeQuiz.get());
}

function requireQuiz(quizId) {
  const quiz = mapQuiz(q.getQuiz.get(quizId));
  if (!quiz) throw new HttpError(404, 'Quiz not found.');
  return quiz;
}

function deadlineOf(attempt, quiz) {
  return Date.parse(attempt.start_time) + quiz.duration_minutes * 60_000;
}

/* ------------------------------------------------------------------ *
 * Per-student question order
 * ------------------------------------------------------------------ */

/**
 * mulberry32 — a small, fast, deterministic PRNG.
 * Determinism is the point: the same seed must always rebuild the same order,
 * so a student who reloads or resumes sees their questions in the same
 * sequence rather than a fresh shuffle.
 */
function seededRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates using a seeded PRNG. Returns a new array; input untouched. */
function shuffleWithSeed(items, seed) {
  const out = items.slice();
  const random = seededRandom(seed);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const newSeed = () => crypto.randomInt(1, 2 ** 31 - 1);

/* ------------------------------------------------------------------ *
 * Scoring
 * ------------------------------------------------------------------ */

/**
 * Grades submitted answers server-side. Answers are keyed by question id as
 * `q<question_id>` (or the bare id) to match the documented payload shape.
 */
function grade(quizId, answers) {
  const rows = q.questionsByQuiz.all(quizId);
  let correct = 0;
  const detail = [];

  for (const row of rows) {
    const raw = answers[`q${row.question_id}`] ?? answers[String(row.question_id)];
    const picked = Number.isInteger(raw) ? raw : Number.parseInt(raw, 10);
    const chosen = Number.isInteger(picked) ? picked : null;
    const isCorrect = chosen === row.correct_option;
    if (isCorrect) correct += 1;
    detail.push({ question_id: row.question_id, chosen, correct_option: row.correct_option, isCorrect });
  }

  const total = rows.length;
  const score = total ? Math.round((correct / total) * 10000) / 100 : 0;
  return { correct, total, score, detail };
}

/* ------------------------------------------------------------------ *
 * Login / attempt start
 * ------------------------------------------------------------------ */

function login({ studentId, name, quizId }) {
  const id = String(studentId || '').trim();
  const fullName = String(name || '').trim();
  if (!id) throw new HttpError(400, 'Student ID is required.');
  if (!fullName) throw new HttpError(400, 'Name is required.');

  const quiz = quizId ? requireQuiz(quizId) : getActiveQuiz();
  if (!quiz) throw new HttpError(409, 'No exam is currently active. Please wait for the administrator.');
  if (!quiz.is_active) throw new HttpError(409, 'This exam is not open.');

  const questionCount = q.countQuestions.get(quiz.quiz_id).n;
  if (questionCount === 0) throw new HttpError(409, 'This exam has no questions yet.');

  q.upsertStudent.run(id, fullName, nowIso());

  const existing = q.attemptByStudentQuiz.get(id, quiz.quiz_id);

  if (existing && existing.status !== 'IN_PROGRESS') {
    throw new HttpError(403, 'Attempt already recorded. Contact administrator for permission.', {
      status_recorded: existing.status,
    });
  }

  let attempt = existing;
  if (!attempt) {
    q.createAttempt.run(id, quiz.quiz_id, questionCount, newToken(), newSeed(), nowIso());
    attempt = q.attemptByStudentQuiz.get(id, quiz.quiz_id);
  }

  // Resume path: dropped Wi-Fi or a browser crash leaves the attempt
  // IN_PROGRESS. Re-entry is allowed, but a fresh token is issued against the
  // ORIGINAL start_time — the clock never resets, so no extra time is gained.
  attempt.token = newToken();
  reissueToken(attempt.attempt_id, attempt.token);

  const expired = finalizeIfExpired(attempt, quiz);
  if (expired) {
    throw new HttpError(403, 'Attempt already recorded. Contact administrator for permission.', {
      status_recorded: expired.status,
    });
  }

  bus.emit('attempt:changed', { quizId: quiz.quiz_id, studentId: id });

  return {
    token: attempt.token,
    student: { studentId: id, name: fullName },
    quiz: { quizId: quiz.quiz_id, title: quiz.title, durationMinutes: quiz.duration_minutes },
    resumed: !!existing,
    endsAt: new Date(deadlineOf(attempt, quiz)).toISOString(),
    savedAnswers: JSON.parse(attempt.answers_json || '{}'),
  };
}

function reissueToken(attemptId, token) {
  reissueTokenStmt.run(token, attemptId);
}

/* ------------------------------------------------------------------ *
 * Session resolution
 * ------------------------------------------------------------------ */

function resolveSession(token) {
  if (!token) throw new HttpError(401, 'Missing exam session token.');
  const attempt = q.attemptByToken.get(token);
  if (!attempt) throw new HttpError(401, 'Exam session is no longer valid. Please log in again.');
  if (attempt.status !== 'IN_PROGRESS') {
    throw new HttpError(403, 'Attempt already recorded. Contact administrator for permission.');
  }
  const quiz = requireQuiz(attempt.quiz_id);
  return { attempt, quiz };
}

/**
 * Question order for one attempt. Shuffled per student when the quiz enables it,
 * so neighbours never see the same question at the same position.
 *
 * Grading is unaffected: answers are keyed by question_id, never by position.
 */
function orderedQuestions(attempt, quiz) {
  const rows = q.questionsByQuiz.all(quiz.quiz_id);
  if (!quiz.shuffle_questions || !attempt.shuffle_seed) return rows;
  return shuffleWithSeed(rows, attempt.shuffle_seed);
}

function examPayload(token) {
  const { attempt, quiz } = resolveSession(token);
  const expired = finalizeIfExpired(attempt, quiz);
  if (expired) throw new HttpError(403, 'Time expired. Your exam was submitted automatically.');

  const student = q.getStudent.get(attempt.student_id);
  return {
    quiz: { quizId: quiz.quiz_id, title: quiz.title, durationMinutes: quiz.duration_minutes },
    student: { studentId: attempt.student_id, name: student ? student.name : attempt.student_id },
    // correct_option is deliberately never serialized to a student client.
    questions: orderedQuestions(attempt, quiz).map((row) => mapQuestion(row)),
    savedAnswers: JSON.parse(attempt.answers_json || '{}'),
    startedAt: attempt.start_time,
    endsAt: new Date(deadlineOf(attempt, quiz)).toISOString(),
    serverTime: nowIso(),
  };
}

function saveProgress(token, answers) {
  const { attempt } = resolveSession(token);
  q.saveProgress.run(JSON.stringify(answers || {}), attempt.attempt_id);
}

/* ------------------------------------------------------------------ *
 * Submission
 * ------------------------------------------------------------------ */

function submit({ token, answers, submissionType = 'MANUAL', reason = null, studentId, quizId }) {
  let attempt;
  let quiz;

  if (token) {
    ({ attempt, quiz } = resolveSession(token));
  } else {
    // Fallback for the documented payload shape (studentId + quizId, no token).
    if (!studentId || !quizId) throw new HttpError(401, 'Missing exam session token.');
    attempt = q.attemptByStudentQuiz.get(String(studentId).trim(), Number(quizId));
    if (!attempt) throw new HttpError(404, 'No active attempt for this student.');
    if (attempt.status !== 'IN_PROGRESS') {
      throw new HttpError(403, 'Attempt already recorded. Contact administrator for permission.');
    }
    quiz = requireQuiz(attempt.quiz_id);
  }

  const type = SUBMISSION_TYPES.has(submissionType) ? submissionType : 'MANUAL';
  return finalize(attempt, quiz, { answers, submissionType: type, reason });
}

/**
 * The single place an attempt is closed out. Idempotent: the UPDATE is guarded
 * on status = 'IN_PROGRESS', so a manual submit racing an auto-submit produces
 * one result, not two.
 */
function finalize(attempt, quiz, { answers, submissionType, reason }) {
  const merged = {
    ...JSON.parse(attempt.answers_json || '{}'),
    ...(answers && typeof answers === 'object' ? answers : {}),
  };

  const { correct, total, score } = grade(quiz.quiz_id, merged);
  const terminated = submissionType === 'AUTO_TERMINATED' || submissionType === 'ADMIN_FORCED';
  const status = terminated ? 'TERMINATED' : 'SUBMITTED';
  const submittedAt = nowIso();

  const res = q.finalizeAttempt.run(
    status, score, correct, total, JSON.stringify(merged),
    submissionType, reason, submittedAt, attempt.attempt_id,
  );

  if (res.changes === 0) {
    // Already closed by a concurrent path — return the stored result as-is.
    const current = q.attemptByStudentQuiz.get(attempt.student_id, attempt.quiz_id);
    return summarizeAttempt(current);
  }

  if (terminated && reason) {
    q.addFlag.run(attempt.student_id, attempt.quiz_id, reason, 'FATAL', submittedAt);
  }

  presence.delete(attempt.token);
  const final = q.attemptByStudentQuiz.get(attempt.student_id, attempt.quiz_id);

  bus.emit('attempt:finalized', {
    quizId: attempt.quiz_id,
    studentId: attempt.student_id,
    status,
    submissionType,
    reason,
    score,
    at: submittedAt,
  });

  return summarizeAttempt(final);
}

function summarizeAttempt(row) {
  if (!row) return null;
  return {
    studentId: row.student_id,
    quizId: row.quiz_id,
    status: row.status,
    score: row.score,
    correct: row.correct_count,
    total: row.total_questions,
    submissionType: row.submission_type,
    reason: row.reason,
    submittedAt: row.submit_time,
  };
}

/**
 * What a student is allowed to see about their own finished attempt.
 *
 * Results are released manually by the invigilator, so marks never leave the
 * server on a student-facing channel. Hiding the score in the UI alone would
 * not be enough — anyone with devtools can read the raw response — so it is
 * stripped here, at the boundary, for every student path (HTTP and socket).
 */
function studentView(summary) {
  if (!summary) return null;
  return {
    studentId: summary.studentId,
    quizId: summary.quizId,
    status: summary.status,
    submissionType: summary.submissionType,
    reason: summary.reason,
    submittedAt: summary.submittedAt,
  };
}

/** Server-side clock enforcement — the client timer is a convenience, not the authority. */
function finalizeIfExpired(attempt, quiz) {
  if (!attempt || attempt.status !== 'IN_PROGRESS') return null;
  if (Date.now() < deadlineOf(attempt, quiz)) return null;
  return finalize(attempt, quiz, {
    answers: null,
    submissionType: 'TIME_EXPIRED',
    reason: 'Time limit reached',
  });
}

/** Sweeps every open attempt; called on a timer so disconnected clients still get closed. */
function sweepExpired() {
  const open = q.inProgressAttempts.all();
  const closed = [];
  for (const attempt of open) {
    const quiz = q.getQuiz.get(attempt.quiz_id);
    if (!quiz) continue;
    const done = finalizeIfExpired(attempt, mapQuiz(quiz));
    if (done) closed.push(done);
  }
  return closed;
}

/* ------------------------------------------------------------------ *
 * Anti-cheat flags
 * ------------------------------------------------------------------ */

function recordFlag({ token, studentId, quizId, reason, severity = 'WARN' }) {
  let sid = studentId;
  let qid = quizId;
  let attempt = null;

  if (token) {
    attempt = q.attemptByToken.get(token);
    if (attempt) {
      sid = attempt.student_id;
      qid = attempt.quiz_id;
    }
  }
  if (!sid || !qid) return null;

  const at = nowIso();
  q.addFlag.run(sid, Number(qid), String(reason || 'Unspecified violation'), severity, at);
  if (attempt) q.bumpViolations.run(attempt.attempt_id);

  const event = { studentId: sid, quizId: Number(qid), reason, severity, at };
  bus.emit('flag', event);
  return event;
}

/**
 * Fatal violation: flags AND terminates in one step. Used by the
 * `flag_and_submit` socket event and the auto-submit REST path.
 */
function flagAndSubmit({ token, studentId, quizId, reason, answers }) {
  recordFlag({ token, studentId, quizId, reason, severity: 'FATAL' });
  return submit({
    token, studentId, quizId, answers,
    submissionType: 'AUTO_TERMINATED',
    reason: String(reason || 'Policy violation'),
  });
}

/* ------------------------------------------------------------------ *
 * Presence (live monitoring)
 * ------------------------------------------------------------------ */

function markOnline(token, socketId) {
  const attempt = q.attemptByToken.get(token);
  if (!attempt || attempt.status !== 'IN_PROGRESS') return null;
  presence.set(token, {
    studentId: attempt.student_id,
    quizId: attempt.quiz_id,
    socketId,
    lastSeen: Date.now(),
  });
  bus.emit('presence:changed', { studentId: attempt.student_id, quizId: attempt.quiz_id, online: true });
  return attempt;
}

function touch(token) {
  const entry = presence.get(token);
  if (entry) entry.lastSeen = Date.now();
}

function markOffline(socketId) {
  for (const [token, entry] of presence) {
    if (entry.socketId !== socketId) continue;
    presence.delete(token);
    bus.emit('presence:changed', { studentId: entry.studentId, quizId: entry.quizId, online: false });
  }
}

function onlineStudentIds(quizId) {
  const set = new Set();
  for (const entry of presence.values()) {
    if (entry.quizId === Number(quizId)) set.add(entry.studentId);
  }
  return set;
}

function socketIdFor(studentId, quizId) {
  for (const entry of presence.values()) {
    if (entry.studentId === studentId && entry.quizId === Number(quizId)) return entry.socketId;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Admin views
 * ------------------------------------------------------------------ */

/** Roster of every known student against one quiz, with derived display status. */
function monitorSnapshot(quizId) {
  const quiz = requireQuiz(quizId);
  const online = onlineStudentIds(quizId);
  const attempts = new Map(
    q.attemptsByQuiz.all(quizId).map((row) => [row.student_id, row]));

  const rows = q.listStudents.all().map((student) => {
    const attempt = attempts.get(student.student_id);
    let display = 'NOT_STARTED';
    if (attempt) {
      if (attempt.status === 'IN_PROGRESS') display = 'IN_PROGRESS';
      else if (attempt.status === 'TERMINATED') display = 'AUTO_TERMINATED';
      else display = 'SUBMITTED';
    }
    return {
      studentId: student.student_id,
      name: student.name,
      display,
      online: online.has(student.student_id),
      score: attempt ? attempt.score : null,
      correct: attempt ? attempt.correct_count : null,
      total: attempt ? attempt.total_questions : null,
      violations: attempt ? attempt.violations : 0,
      submissionType: attempt ? attempt.submission_type : null,
      reason: attempt ? attempt.reason : null,
      startTime: attempt ? attempt.start_time : null,
      submitTime: attempt ? attempt.submit_time : null,
      answered: attempt ? Object.keys(JSON.parse(attempt.answers_json || '{}')).length : 0,
    };
  });

  const counts = rows.reduce((acc, r) => {
    acc[r.display] = (acc[r.display] || 0) + 1;
    return acc;
  }, { NOT_STARTED: 0, IN_PROGRESS: 0, SUBMITTED: 0, AUTO_TERMINATED: 0 });

  return {
    quiz,
    questionCount: q.countQuestions.get(quizId).n,
    students: rows,
    counts,
    onlineCount: online.size,
    flags: q.flagsByQuiz.all(quizId, 100).map((f) => ({
      studentId: f.student_id, reason: f.reason, severity: f.severity, at: f.created_at,
    })),
    serverTime: nowIso(),
  };
}

/**
 * One student's complete paper: every question, what they picked, and the
 * correct answer. Used by the Results panel and the PDF export.
 *
 * Questions come back in the order that student actually saw them, so a paper
 * being reviewed or disputed matches what was on their screen.
 */
function answerSheet(quizId, studentId) {
  const sid = String(studentId || '').trim();
  const qid = Number(quizId);
  if (!sid || !Number.isInteger(qid)) {
    throw new HttpError(400, 'studentId and quizId are required.');
  }
  const quiz = requireQuiz(qid);

  const attempt = q.attemptByStudentQuiz.get(sid, qid);
  if (!attempt) throw new HttpError(404, 'No attempt on record for this student.');

  const student = q.getStudent.get(sid);
  const answers = JSON.parse(attempt.answers_json || '{}');
  const rows = orderedQuestions(attempt, quiz);

  const questions = rows.map((row, index) => {
    const raw = answers[`q${row.question_id}`] ?? answers[String(row.question_id)];
    const parsed = Number.isInteger(raw) ? raw : Number.parseInt(raw, 10);
    const chosen = Number.isInteger(parsed) ? parsed : null;
    return {
      shownAs: index + 1,             // position on this student's paper
      authoredAs: row.position + 1,   // position as written by the examiner
      question_id: row.question_id,
      question_text: row.question_text,
      options: JSON.parse(row.options),
      has_image: !!row.has_image,
      chosen,
      correct_option: row.correct_option,
      isCorrect: chosen === row.correct_option,
      answered: chosen !== null,
    };
  });

  const answered = questions.filter((item) => item.answered).length;

  return {
    quiz: {
      quiz_id: quiz.quiz_id,
      title: quiz.title,
      duration_minutes: quiz.duration_minutes,
      shuffled: !!(quiz.shuffle_questions && attempt.shuffle_seed),
    },
    student: { studentId: sid, name: student ? student.name : sid },
    attempt: {
      status: attempt.status,
      score: attempt.score,
      correct: attempt.correct_count,
      total: attempt.total_questions,
      submissionType: attempt.submission_type,
      reason: attempt.reason,
      violations: attempt.violations,
      startTime: attempt.start_time,
      submitTime: attempt.submit_time,
    },
    flags: q.flagsForStudent.all(qid, sid).map((f) => ({
      reason: f.reason, severity: f.severity, at: f.created_at,
    })),
    counts: {
      answered,
      unanswered: questions.length - answered,
      correct: questions.filter((item) => item.isCorrect).length,
      wrong: questions.filter((item) => item.answered && !item.isCorrect).length,
      total: questions.length,
    },
    questions,
    generatedAt: nowIso(),
  };
}

/** Every student who has an attempt on this quiz, in submission order. */
function answerSheetsForQuiz(quizId) {
  return q.attemptsByQuiz.all(Number(quizId))
    .map((row) => answerSheet(quizId, row.student_id));
}

function resetAttempt({ studentId, quizId, clearFlags = true }) {
  const sid = String(studentId || '').trim();
  const qid = Number(quizId);
  if (!sid || !Number.isInteger(qid)) throw new HttpError(400, 'studentId and quizId are required.');
  requireQuiz(qid);

  const existing = q.attemptByStudentQuiz.get(sid, qid);
  if (!existing) throw new HttpError(404, 'No attempt on record for this student.');

  if (existing.token) presence.delete(existing.token);
  q.deleteAttempt.run(sid, qid);
  if (clearFlags) q.deleteFlags.run(sid, qid);

  bus.emit('attempt:reset', { studentId: sid, quizId: qid, previousStatus: existing.status });
  return { studentId: sid, quizId: qid, previousStatus: existing.status };
}

module.exports = {
  bus, HttpError, presence,
  login, resolveSession, examPayload, saveProgress,
  orderedQuestions, shuffleWithSeed, seededRandom,
  submit, finalize, flagAndSubmit, recordFlag, grade,
  sweepExpired, finalizeIfExpired, deadlineOf,
  monitorSnapshot, resetAttempt, summarizeAttempt, studentView,
  answerSheet, answerSheetsForQuiz,
  getActiveQuiz, requireQuiz,
  markOnline, markOffline, touch, socketIdFor, onlineStudentIds,
};
