'use strict';

/**
 * Upgrade safety: a database created by an earlier version must gain the new
 * columns without losing data. Runs in a child process because src/db.js binds
 * to DB_FILE once, at require time.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');

/** Builds a database with the pre-images, pre-shuffle schema. */
function makeLegacyDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE students (
      student_id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE quizzes (
      quiz_id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
      is_active INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE questions (
      question_id INTEGER PRIMARY KEY AUTOINCREMENT,
      quiz_id INTEGER NOT NULL REFERENCES quizzes(quiz_id) ON DELETE CASCADE,
      question_text TEXT NOT NULL, options TEXT NOT NULL,
      correct_option INTEGER NOT NULL, position INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE attempts (
      attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
      quiz_id INTEGER NOT NULL REFERENCES quizzes(quiz_id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('IN_PROGRESS','SUBMITTED','TERMINATED')),
      score REAL NOT NULL DEFAULT 0.0, correct_count INTEGER NOT NULL DEFAULT 0,
      total_questions INTEGER NOT NULL DEFAULT 0,
      answers_json TEXT NOT NULL DEFAULT '{}', submission_type TEXT, reason TEXT,
      violations INTEGER NOT NULL DEFAULT 0, token TEXT,
      start_time TEXT NOT NULL, submit_time TEXT);
    CREATE TABLE flags (
      flag_id INTEGER PRIMARY KEY AUTOINCREMENT, student_id TEXT NOT NULL,
      quiz_id INTEGER NOT NULL, reason TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'WARN', created_at TEXT NOT NULL);
  `);

  const now = new Date().toISOString();
  db.prepare('INSERT INTO students VALUES (?,?,?)').run('OLD-001', 'Legacy Student', now);
  db.prepare('INSERT INTO quizzes (title,duration_minutes,is_active,created_at) VALUES (?,?,?,?)')
    .run('Legacy Exam', 25, 1, now);
  const insertQuestion = db.prepare(
    'INSERT INTO questions (quiz_id,question_text,options,correct_option,position) VALUES (?,?,?,?,?)');
  for (let i = 0; i < 4; i += 1) {
    insertQuestion.run(1, `Legacy question ${i + 1}`, JSON.stringify(['a', 'b', 'c', 'd']), i % 4, i);
  }
  db.prepare(`INSERT INTO attempts
      (student_id,quiz_id,status,score,correct_count,total_questions,answers_json,
       submission_type,start_time,submit_time)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run('OLD-001', 1, 'SUBMITTED', 75, 3, 4, '{"q1":0}', 'MANUAL', now, now);
  db.close();
}

/** Runs a snippet with src/db.js pointed at `file`, returns parsed JSON stdout. */
function inspect(file) {
  const script = `
    const { db, q, mapQuiz } = require(${JSON.stringify(path.join(ROOT, 'src', 'db.js'))});
    const cols = (t) => db.prepare('PRAGMA table_info(' + t + ')').all().map((c) => c.name);
    process.stdout.write(JSON.stringify({
      quizCols: cols('quizzes'),
      questionCols: cols('questions'),
      attemptCols: cols('attempts'),
      quizzes: q.listQuizzes.all().map(mapQuiz),
      questionCount: q.countQuestions.get(1).n,
      attempt: db.prepare('SELECT student_id, status, score, shuffle_seed FROM attempts').get(),
      settingsTable: cols('settings').length > 0,
    }));
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: ROOT,
    env: { ...process.env, DB_FILE: file, NODE_NO_WARNINGS: '1' },
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

test('a legacy database is migrated in place without data loss', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-migrate-'));
  const file = path.join(dir, 'legacy.db');

  try {
    makeLegacyDb(file);
    const after = inspect(file);

    // New columns exist.
    assert.ok(after.quizCols.includes('shuffle_questions'));
    assert.ok(after.questionCols.includes('image_data'));
    assert.ok(after.questionCols.includes('image_mime'));
    assert.ok(after.attemptCols.includes('shuffle_seed'));
    assert.ok(after.settingsTable, 'the settings table is created on upgrade');

    // Existing data survives untouched.
    assert.equal(after.quizzes.length, 1);
    assert.equal(after.quizzes[0].title, 'Legacy Exam');
    assert.equal(after.quizzes[0].duration_minutes, 25);
    assert.equal(after.quizzes[0].is_active, true);
    assert.equal(after.questionCount, 4);
    assert.equal(after.attempt.student_id, 'OLD-001');
    assert.equal(after.attempt.status, 'SUBMITTED');
    assert.equal(after.attempt.score, 75);

    // Sensible defaults for rows that predate the columns.
    assert.equal(after.quizzes[0].shuffle_questions, true,
      'existing quizzes default to shuffled');
    assert.equal(after.attempt.shuffle_seed, null,
      'pre-existing attempts have no seed');

    // Re-running must be a no-op, not an error (every boot re-runs migrations).
    const again = inspect(file);
    assert.deepEqual(again.quizCols, after.quizCols);
    assert.equal(again.questionCount, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an attempt with no seed falls back to the authored order', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-seedless-'));
  const file = path.join(dir, 'legacy.db');

  try {
    makeLegacyDb(file);
    const script = `
      const { q, mapQuiz } = require(${JSON.stringify(path.join(ROOT, 'src', 'db.js'))});
      const svc = require(${JSON.stringify(path.join(ROOT, 'src', 'service.js'))});
      const quiz = mapQuiz(q.getQuiz.get(1));
      // shuffle_seed is null on attempts that predate the feature.
      const rows = svc.orderedQuestions({ shuffle_seed: null }, quiz);
      process.stdout.write(JSON.stringify(rows.map((r) => r.question_text)));
    `;
    const out = execFileSync(process.execPath, ['-e', script], {
      cwd: ROOT,
      env: { ...process.env, DB_FILE: file, NODE_NO_WARNINGS: '1' },
      encoding: 'utf8',
    });

    assert.deepEqual(JSON.parse(out), [
      'Legacy question 1', 'Legacy question 2', 'Legacy question 3', 'Legacy question 4',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
