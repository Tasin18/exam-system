'use strict';

const express = require('express');
const { db, q, nowIso, mapQuiz, mapQuestion } = require('./db');
const svc = require('./service');
const adminAuth = require('./admin-auth');
const { renderAnswerSheets } = require('./pdf');

/** Pull the exam session token off the request (header or body). */
function examToken(req) {
  const header = req.get('authorization') || '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return req.get('x-exam-token') || (req.body && req.body.token) || null;
}

/**
 * Wraps a handler so thrown HttpErrors become clean JSON responses.
 * Async handlers are supported — a rejected promise is reported the same way.
 */
function handle(fn) {
  const fail = (res, err) => {
    const status = err.status || 500;
    if (status >= 500) console.error('[api]', err);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const body = { error: err.message || 'Internal server error.' };
    if (err.status_recorded) body.status = err.status_recorded;
    res.status(status).json(body);
  };

  return (req, res) => {
    try {
      const result = fn(req, res);
      if (result && typeof result.then === 'function') {
        result.catch((err) => fail(res, err));
      }
    } catch (err) {
      fail(res, err);
    }
  };
}

// Raster formats every browser renders. SVG is excluded on purpose: it can
// carry script, and these files are uploaded by one user and shown to a class.
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

/**
 * Decodes a `data:image/...;base64,...` URI into a storable blob.
 * Returns null when there is no image, and throws on anything malformed.
 */
function decodeImage(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new svc.HttpError(400, `${label}: invalid image.`);

  const match = /^data:([a-z0-9/+.-]+);base64,([\s\S]+)$/i.exec(value.trim());
  if (!match) {
    throw new svc.HttpError(400, `${label}: image must be a base64 data URI.`);
  }

  const mime = match[1].toLowerCase();
  if (!IMAGE_MIMES.has(mime)) {
    throw new svc.HttpError(400,
      `${label}: unsupported image type "${mime}". Use PNG, JPEG, GIF or WebP.`);
  }

  let buffer;
  try {
    buffer = Buffer.from(match[2], 'base64');
  } catch {
    throw new svc.HttpError(400, `${label}: image data could not be decoded.`);
  }
  if (!buffer.length) throw new svc.HttpError(400, `${label}: image is empty.`);
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new svc.HttpError(400,
      `${label}: image is ${(buffer.length / 1048576).toFixed(1)} MB — the limit is 3 MB.`);
  }
  return { buffer, mime };
}

function validateQuestions(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new svc.HttpError(400, 'At least one question is required.');
  }
  return input.map((item, index) => {
    const text = String(item.question_text ?? item.text ?? '').trim();
    const options = (item.options || []).map((o) => String(o ?? '').trim());
    const correct = Number(item.correct_option ?? item.correct ?? -1);

    if (!text) throw new svc.HttpError(400, `Question ${index + 1}: text is required.`);
    if (options.length < 2) {
      throw new svc.HttpError(400, `Question ${index + 1}: at least 2 options are required.`);
    }
    if (options.some((o) => !o)) {
      throw new svc.HttpError(400, `Question ${index + 1}: options cannot be blank.`);
    }
    if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) {
      throw new svc.HttpError(400,
        `Question ${index + 1}: correct_option must be an index between 0 and ${options.length - 1}.`);
    }
    const image = decodeImage(item.image, `Question ${index + 1}`);
    return { text, options, correct, position: index, image };
  });
}

/**
 * Names a duplicate: "Midterm" -> "Midterm (Copy)", then "(Copy 2)", "(Copy 3)".
 *
 * Copying a copy strips the existing suffix first, so repeatedly duplicating
 * gives "Midterm (Copy 3)" rather than "Midterm (Copy) (Copy) (Copy)". Titles
 * are not unique in the schema; this is about keeping the admin list readable,
 * not about enforcing anything.
 */
function copyTitle(original) {
  const base = String(original).replace(/\s*\(Copy(?:\s+\d+)?\)\s*$/i, '').trim()
    || 'Untitled quiz';
  const taken = new Set(q.listQuizzes.all().map((row) => row.title));
  let candidate = `${base} (Copy)`;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${base} (Copy ${n})`;
  return candidate;
}

/** Writes a validated question set, replacing whatever the quiz had. */
function writeQuestions(quizId, parsed) {
  for (const item of parsed) {
    q.addQuestion.run(
      quizId, item.text, JSON.stringify(item.options), item.correct, item.position,
      item.image ? item.image.buffer : null,
      item.image ? item.image.mime : null,
    );
  }
}

/** Filename-safe fragment for Content-Disposition. */
function slug(value) {
  return String(value || '').replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60) || 'export';
}

/**
 * Renders the PDF fully before replying, so a layout failure produces a clean
 * JSON error instead of a truncated download.
 */
async function sendPdf(res, sheets, filename, { inline = false } = {}) {
  const pdf = await renderAnswerSheets(sheets);
  res.setHeader('Content-Type', 'application/pdf');
  // `?inline=1` renders in the browser's PDF viewer instead of downloading,
  // which makes the URL usable directly in a tab.
  res.setHeader('Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename="${filename}"`);
  res.setHeader('Content-Length', pdf.length);
  res.setHeader('Cache-Control', 'no-store');
  res.end(pdf);
}

const wantsInline = (req) => req.query.inline === '1' || req.query.inline === 'true';

function csvCell(value) {
  const str = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function buildRouter() {
  const router = express.Router();

  /* ================= Student: auth & pre-check ================= */

  router.get('/quiz/active', handle((req, res) => {
    const quiz = svc.getActiveQuiz();
    if (!quiz) return res.json({ active: false });
    res.json({
      active: true,
      quizId: quiz.quiz_id,
      title: quiz.title,
      durationMinutes: quiz.duration_minutes,
      questionCount: q.countQuestions.get(quiz.quiz_id).n,
    });
  }));

  router.post('/auth/login', handle((req, res) => {
    const { studentId, name, quizId } = req.body || {};
    res.json(svc.login({ studentId, name, quizId }));
  }));

  /* ================= Student: exam ================= */

  router.get('/quiz/exam', handle((req, res) => {
    res.json(svc.examPayload(examToken(req)));
  }));

  /**
   * Question image. An <img> tag cannot send an Authorization header, so the
   * token travels as a query param — the same approach the CSV export uses.
   * A student may only read images belonging to the quiz they are sitting.
   */
  router.get('/quiz/image/:questionId', handle((req, res) => {
    const questionId = Number(req.params.questionId);
    if (!Number.isInteger(questionId)) throw new svc.HttpError(400, 'Invalid question id.');

    const row = q.questionImage.get(questionId);
    if (!row || !row.image_data) throw new svc.HttpError(404, 'No image for this question.');

    const adminToken = adminAuth.tokenFrom(req);
    if (!adminAuth.verify(adminToken)) {
      const token = req.query.t || examToken(req);
      const { attempt } = svc.resolveSession(token);
      if (attempt.quiz_id !== row.quiz_id) {
        throw new svc.HttpError(403, 'This image belongs to a different exam.');
      }
    }

    res.setHeader('Content-Type', row.image_mime || 'application/octet-stream');
    // Immutable: a question's image never changes without a new question id.
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(Buffer.from(row.image_data));
  }));

  router.post('/quiz/progress', handle((req, res) => {
    svc.saveProgress(examToken(req), (req.body || {}).answers);
    res.json({ saved: true, at: nowIso() });
  }));

  router.post('/quiz/submit', handle((req, res) => {
    const { answers, submissionType, reason, studentId, quizId } = req.body || {};
    const result = svc.submit({
      token: examToken(req),
      answers, submissionType, reason, studentId, quizId,
    });
    // No score: results are released by the invigilator, not by this response.
    res.json({ ok: true, result: svc.studentView(result) });
  }));

  /** HTTP twin of the `flag_and_submit` socket event — used as the sendBeacon
   *  fallback so a violation still lands if the socket is already gone. */
  router.post('/quiz/flag-submit', handle((req, res) => {
    const { reason, answers, studentId, quizId } = req.body || {};
    const result = svc.flagAndSubmit({
      token: examToken(req), reason, answers, studentId, quizId,
    });
    res.json({ ok: true, result: svc.studentView(result) });
  }));

  router.post('/quiz/flag', handle((req, res) => {
    const { reason, severity } = req.body || {};
    const event = svc.recordFlag({ token: examToken(req), reason, severity: severity || 'WARN' });
    res.json({ ok: true, flag: event });
  }));

  /* ================= Admin: session ================= */

  router.post('/admin/login', handle((req, res) => {
    const token = adminAuth.issue((req.body || {}).password);
    if (!token) throw new svc.HttpError(401, 'Incorrect administrator password.');
    res.json({ token });
  }));

  router.get('/admin/session', adminAuth.requireAdmin, handle((req, res) => {
    res.json({ ok: true });
  }));

  /* ================= Admin: quiz CRUD ================= */

  router.get('/admin/quizzes', adminAuth.requireAdmin, handle((req, res) => {
    const quizzes = q.listQuizzes.all().map((row) => {
      const quiz = mapQuiz(row);
      quiz.question_count = q.countQuestions.get(quiz.quiz_id).n;
      return quiz;
    });
    res.json({ quizzes });
  }));

  router.get('/admin/quizzes/:id', adminAuth.requireAdmin, handle((req, res) => {
    const quiz = svc.requireQuiz(Number(req.params.id));
    res.json({
      quiz,
      // Admin view includes the answer key, plus each image inlined as a data
      // URI. Saving replaces the whole question set, so the editor has to be
      // able to hand every image back untouched.
      questions: q.questionsByQuiz.all(quiz.quiz_id).map((row) => {
        const question = mapQuestion(row, { includeAnswer: true });
        if (question.has_image) {
          const image = q.questionImage.get(question.question_id);
          if (image && image.image_data) {
            question.image = `data:${image.image_mime};base64,`
              + Buffer.from(image.image_data).toString('base64');
          }
        }
        return question;
      }),
    });
  }));

  router.post('/admin/quizzes', adminAuth.requireAdmin, handle((req, res) => {
    const { title, durationMinutes, isActive, questions, shuffleQuestions } = req.body || {};
    const cleanTitle = String(title || '').trim();
    const duration = Number(durationMinutes);
    if (!cleanTitle) throw new svc.HttpError(400, 'Quiz title is required.');
    if (!Number.isInteger(duration) || duration <= 0) {
      throw new svc.HttpError(400, 'durationMinutes must be a positive integer.');
    }
    const parsed = validateQuestions(questions);
    const shuffle = shuffleQuestions === undefined ? true : !!shuffleQuestions;

    const info = q.createQuiz.run(
      cleanTitle, duration, isActive ? 1 : 0, shuffle ? 1 : 0, nowIso());
    const quizId = Number(info.lastInsertRowid);
    writeQuestions(quizId, parsed);
    if (isActive) activateOnly(quizId);

    res.status(201).json({ quiz: mapQuiz(q.getQuiz.get(quizId)) });
  }));

  router.put('/admin/quizzes/:id', adminAuth.requireAdmin, handle((req, res) => {
    const quizId = Number(req.params.id);
    const existing = svc.requireQuiz(quizId);
    const { title, durationMinutes, isActive, questions, shuffleQuestions } = req.body || {};

    const cleanTitle = title === undefined ? existing.title : String(title).trim();
    const duration = durationMinutes === undefined
      ? existing.duration_minutes : Number(durationMinutes);
    if (!cleanTitle) throw new svc.HttpError(400, 'Quiz title is required.');
    if (!Number.isInteger(duration) || duration <= 0) {
      throw new svc.HttpError(400, 'durationMinutes must be a positive integer.');
    }

    // Editing questions mid-exam would invalidate answers already recorded
    // against the old question ids.
    if (questions !== undefined) {
      const live = q.attemptsByQuiz.all(quizId).filter((a) => a.status === 'IN_PROGRESS');
      if (live.length) {
        throw new svc.HttpError(409,
          `Cannot edit questions while ${live.length} student(s) are mid-exam.`);
      }
      const parsed = validateQuestions(questions);
      q.deleteQuestionsByQuiz.run(quizId);
      writeQuestions(quizId, parsed);
    }

    const active = isActive === undefined ? existing.is_active : !!isActive;
    const shuffle = shuffleQuestions === undefined
      ? existing.shuffle_questions : !!shuffleQuestions;
    q.updateQuiz.run(cleanTitle, duration, active ? 1 : 0, shuffle ? 1 : 0, quizId);
    if (active) activateOnly(quizId);

    res.json({ quiz: mapQuiz(q.getQuiz.get(quizId)) });
  }));

  /**
   * Duplicates a quiz: settings, questions, answer key and images.
   *
   * Two deliberate omissions:
   *
   *  - **The copy is always inactive**, whatever the original was. Only one quiz
   *    can be active at a time, so copying an active exam and inheriting that
   *    flag would knock the running exam offline mid-sitting. Activating stays a
   *    separate, deliberate click.
   *  - **Attempts and results are not copied.** The point of a duplicate is a
   *    fresh sitting, and single-attempt enforcement is keyed on
   *    (student_id, quiz_id) - so every student may sit the copy exactly once,
   *    regardless of what they did on the original.
   *
   * An optional `title` in the body overrides the generated "(Copy)" name.
   */
  router.post('/admin/quizzes/:id/duplicate', adminAuth.requireAdmin, handle((req, res) => {
    const quizId = Number(req.params.id);
    const source = svc.requireQuiz(quizId);

    const requested = String((req.body || {}).title || '').trim();
    const title = requested || copyTitle(source.title);

    const rows = q.questionsForCopy.all(quizId);

    // One transaction: a failure part-way through must not leave a quiz holding
    // half its questions, which would look like a complete exam in the list.
    db.exec('BEGIN IMMEDIATE');
    let newId;
    try {
      const info = q.createQuiz.run(
        title, source.duration_minutes, 0, source.shuffle_questions ? 1 : 0, nowIso());
      newId = Number(info.lastInsertRowid);
      // Positions are renumbered from 1 so a source with gaps copies clean.
      rows.forEach((row, index) => {
        q.addQuestion.run(newId, row.question_text, row.options, row.correct_option,
          index + 1, row.image_data, row.image_mime);
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    res.status(201).json({
      quiz: mapQuiz(q.getQuiz.get(newId)),
      copiedFrom: quizId,
      copiedQuestions: rows.length,
      copiedImages: rows.filter((row) => row.image_data).length,
    });
  }));

  router.post('/admin/quizzes/:id/activate', adminAuth.requireAdmin, handle((req, res) => {
    const quizId = Number(req.params.id);
    svc.requireQuiz(quizId);
    const activate = (req.body || {}).active !== false;
    if (activate) {
      if (q.countQuestions.get(quizId).n === 0) {
        throw new svc.HttpError(409, 'Add questions before activating this quiz.');
      }
      activateOnly(quizId);
    } else {
      const quiz = svc.requireQuiz(quizId);
      q.updateQuiz.run(
        quiz.title, quiz.duration_minutes, 0, quiz.shuffle_questions ? 1 : 0, quizId);
    }
    svc.bus.emit('quiz:changed', { quizId });
    res.json({ quiz: mapQuiz(q.getQuiz.get(quizId)) });
  }));

  router.delete('/admin/quizzes/:id', adminAuth.requireAdmin, handle((req, res) => {
    const quizId = Number(req.params.id);
    svc.requireQuiz(quizId);
    q.deleteQuiz.run(quizId); // cascades to questions and attempts
    svc.bus.emit('quiz:changed', { quizId });
    res.json({ deleted: quizId });
  }));

  /* ================= Admin: monitoring & overrides ================= */

  router.get('/admin/monitor/:quizId', adminAuth.requireAdmin, handle((req, res) => {
    res.json(svc.monitorSnapshot(Number(req.params.quizId)));
  }));

  router.post('/admin/reset-attempt', adminAuth.requireAdmin, handle((req, res) => {
    const { studentId, quizId } = req.body || {};
    res.json({ ok: true, reset: svc.resetAttempt({ studentId, quizId }) });
  }));

  router.post('/admin/force-submit', adminAuth.requireAdmin, handle((req, res) => {
    const { studentId, quizId } = req.body || {};
    const attempt = q.attemptByStudentQuiz.get(String(studentId || '').trim(), Number(quizId));
    if (!attempt) throw new svc.HttpError(404, 'No attempt on record for this student.');
    if (attempt.status !== 'IN_PROGRESS') {
      throw new svc.HttpError(409, `Attempt is already ${attempt.status}.`);
    }
    const quiz = svc.requireQuiz(attempt.quiz_id);
    const result = svc.finalize(attempt, quiz, {
      answers: null,
      submissionType: 'ADMIN_FORCED',
      reason: 'Terminated by administrator',
    });
    res.json({ ok: true, result });
  }));

  router.get('/admin/students', adminAuth.requireAdmin, handle((req, res) => {
    res.json({ students: q.listStudents.all() });
  }));

  router.delete('/admin/students/:studentId', adminAuth.requireAdmin, handle((req, res) => {
    q.deleteStudent.run(req.params.studentId); // cascades to attempts
    res.json({ deleted: req.params.studentId });
  }));

  /* ================= Admin: results & export ================= */

  router.get('/admin/results/:quizId', adminAuth.requireAdmin, handle((req, res) => {
    const quizId = Number(req.params.quizId);
    const quiz = svc.requireQuiz(quizId);
    const rows = q.attemptsByQuiz.all(quizId).map((a) => ({
      ...svc.summarizeAttempt(a),
      name: a.name,
      violations: a.violations,
      startTime: a.start_time,
      answers: JSON.parse(a.answers_json || '{}'),
      flags: q.flagsForStudent.all(quizId, a.student_id)
        .map((f) => ({ reason: f.reason, severity: f.severity, at: f.created_at })),
    }));
    res.json({ quiz, results: rows });
  }));

  /* ---- Individual response sheets ---- */

  router.get('/admin/results/:quizId/student/:studentId', adminAuth.requireAdmin,
    handle((req, res) => {
      res.json(svc.answerSheet(Number(req.params.quizId), req.params.studentId));
    }));

  /** One student's paper as a PDF, carrying their ID, answers and the key. */
  router.get('/admin/results/:quizId/student/:studentId/answers.pdf', adminAuth.requireAdmin,
    handle((req, res) => {
      const sheet = svc.answerSheet(Number(req.params.quizId), req.params.studentId);
      const name = `answers-${slug(sheet.student.studentId)}-${slug(sheet.quiz.title)}.pdf`;
      return sendPdf(res, [sheet], name, { inline: wantsInline(req) });
    }));

  /** Every student's paper in one file, for archiving after the exam. */
  router.get('/admin/results/:quizId/answers.pdf', adminAuth.requireAdmin, handle((req, res) => {
    const quizId = Number(req.params.quizId);
    const quiz = svc.requireQuiz(quizId);
    const sheets = svc.answerSheetsForQuiz(quizId);
    if (!sheets.length) throw new svc.HttpError(404, 'No attempts recorded for this quiz yet.');
    return sendPdf(res, sheets, `answers-all-${slug(quiz.title)}.pdf`,
      { inline: wantsInline(req) });
  }));

  router.get('/admin/results/:quizId/export.csv', adminAuth.requireAdmin, handle((req, res) => {
    const quizId = Number(req.params.quizId);
    const quiz = svc.requireQuiz(quizId);
    const header = [
      'Student ID', 'Name', 'Status', 'Score (%)', 'Correct', 'Total',
      'Submission Type', 'Violations', 'Reason', 'Start Time', 'Submit Time',
    ];
    const lines = [header.join(',')];

    for (const a of q.attemptsByQuiz.all(quizId)) {
      lines.push([
        a.student_id, a.name, a.status, a.score, a.correct_count, a.total_questions,
        a.submission_type, a.violations, a.reason, a.start_time, a.submit_time,
      ].map(csvCell).join(','));
    }

    const slug = quiz.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="results-${slug || quiz.quiz_id}.csv"`);
    // BOM so Excel opens UTF-8 names correctly.
    res.send('﻿' + lines.join('\r\n') + '\r\n');
  }));

  return router;
}

/** Exactly one quiz may be active at a time — students never have to pick. */
function activateOnly(quizId) {
  const quiz = svc.requireQuiz(quizId);
  q.deactivateAll.run();
  q.updateQuiz.run(
    quiz.title, quiz.duration_minutes, 1, quiz.shuffle_questions ? 1 : 0, quizId);
}

module.exports = { buildRouter, examToken };
