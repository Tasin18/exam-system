'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'exam.db');

if (DB_FILE !== ':memory:') {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
}

const db = new DatabaseSync(DB_FILE);

// WAL keeps concurrent reads fast while a submit is writing — matters when a
// whole class submits inside the same few seconds.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS students (
    student_id  TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS quizzes (
    quiz_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title            TEXT    NOT NULL,
    duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
    is_active        INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS questions (
    question_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    quiz_id        INTEGER NOT NULL REFERENCES quizzes(quiz_id) ON DELETE CASCADE,
    question_text  TEXT    NOT NULL,
    options        TEXT    NOT NULL,               -- JSON array of option strings
    correct_option INTEGER NOT NULL,               -- index into options
    position       INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_questions_quiz ON questions(quiz_id, position);

  CREATE TABLE IF NOT EXISTS attempts (
    attempt_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id      TEXT    NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
    quiz_id         INTEGER NOT NULL REFERENCES quizzes(quiz_id) ON DELETE CASCADE,
    status          TEXT    NOT NULL CHECK (status IN ('IN_PROGRESS','SUBMITTED','TERMINATED')),
    score           REAL    NOT NULL DEFAULT 0.0,  -- percentage, 0-100
    correct_count   INTEGER NOT NULL DEFAULT 0,
    total_questions INTEGER NOT NULL DEFAULT 0,
    answers_json    TEXT    NOT NULL DEFAULT '{}',
    submission_type TEXT,                          -- MANUAL | AUTO_TERMINATED | TIME_EXPIRED | ADMIN_FORCED
    reason          TEXT,                          -- violation description when TERMINATED
    violations      INTEGER NOT NULL DEFAULT 0,
    token           TEXT,                          -- exam session token
    start_time      TEXT    NOT NULL,
    submit_time     TEXT
  );

  -- Enforces the single-attempt rule at the storage layer, not just in app code.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_unique ON attempts(student_id, quiz_id);
  CREATE INDEX IF NOT EXISTS idx_attempts_token ON attempts(token);

  CREATE TABLE IF NOT EXISTS flags (
    flag_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id  TEXT    NOT NULL,
    quiz_id     INTEGER NOT NULL,
    reason      TEXT    NOT NULL,
    severity    TEXT    NOT NULL DEFAULT 'WARN' CHECK (severity IN ('WARN','FATAL')),
    created_at  TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_flags_lookup ON flags(quiz_id, student_id, flag_id);

  -- Small key/value store for host settings that must survive a restart.
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

/* ------------------------------------------------------------------ *
 * Migrations — CREATE TABLE IF NOT EXISTS cannot add columns to a
 * database created by an earlier version, so widen it in place.
 * ------------------------------------------------------------------ */

function addColumn(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all()
    .some((col) => col.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

addColumn('questions', 'image_data', 'BLOB');
addColumn('questions', 'image_mime', 'TEXT');
addColumn('quizzes', 'shuffle_questions', 'INTEGER NOT NULL DEFAULT 1');
addColumn('attempts', 'shuffle_seed', 'INTEGER');

const nowIso = () => new Date().toISOString();

/* ------------------------------------------------------------------ *
 * Statements
 * ------------------------------------------------------------------ */

const q = {
  upsertStudent: db.prepare(`
    INSERT INTO students (student_id, name, created_at) VALUES (?, ?, ?)
    ON CONFLICT(student_id) DO UPDATE SET name = excluded.name`),
  getStudent: db.prepare('SELECT * FROM students WHERE student_id = ?'),
  listStudents: db.prepare('SELECT * FROM students ORDER BY student_id'),
  deleteStudent: db.prepare('DELETE FROM students WHERE student_id = ?'),

  createQuiz: db.prepare(`
    INSERT INTO quizzes (title, duration_minutes, is_active, shuffle_questions, created_at)
    VALUES (?, ?, ?, ?, ?)`),
  updateQuiz: db.prepare(`
    UPDATE quizzes SET title = ?, duration_minutes = ?, is_active = ?, shuffle_questions = ?
     WHERE quiz_id = ?`),
  getQuiz: db.prepare('SELECT * FROM quizzes WHERE quiz_id = ?'),
  listQuizzes: db.prepare('SELECT * FROM quizzes ORDER BY quiz_id DESC'),
  deleteQuiz: db.prepare('DELETE FROM quizzes WHERE quiz_id = ?'),
  activeQuiz: db.prepare('SELECT * FROM quizzes WHERE is_active = 1 ORDER BY quiz_id DESC LIMIT 1'),
  deactivateAll: db.prepare('UPDATE quizzes SET is_active = 0'),

  addQuestion: db.prepare(`
    INSERT INTO questions
      (quiz_id, question_text, options, correct_option, position, image_data, image_mime)
    VALUES (?, ?, ?, ?, ?, ?, ?)`),
  // Excludes image_data: the blob must never ride along in a JSON payload.
  questionsByQuiz: db.prepare(`
    SELECT question_id, quiz_id, question_text, options, correct_option, position,
           image_mime, (image_data IS NOT NULL) AS has_image
      FROM questions WHERE quiz_id = ? ORDER BY position, question_id`),
  questionImage: db.prepare(
    'SELECT quiz_id, image_data, image_mime FROM questions WHERE question_id = ?'),
  // Includes image_data, unlike questionsByQuiz: duplicating a quiz copies the
  // blobs straight across. Server-side only — never hand these rows to JSON.
  questionsForCopy: db.prepare(`
    SELECT question_text, options, correct_option, position, image_data, image_mime
      FROM questions WHERE quiz_id = ? ORDER BY position, question_id`),
  deleteQuestionsByQuiz: db.prepare('DELETE FROM questions WHERE quiz_id = ?'),
  countQuestions: db.prepare('SELECT COUNT(*) AS n FROM questions WHERE quiz_id = ?'),

  createAttempt: db.prepare(`
    INSERT INTO attempts
      (student_id, quiz_id, status, total_questions, token, shuffle_seed, start_time)
    VALUES (?, ?, 'IN_PROGRESS', ?, ?, ?, ?)`),
  attemptByStudentQuiz: db.prepare(
    'SELECT * FROM attempts WHERE student_id = ? AND quiz_id = ?'),
  attemptByToken: db.prepare('SELECT * FROM attempts WHERE token = ?'),
  attemptsByQuiz: db.prepare(`
    SELECT a.*, s.name FROM attempts a
    JOIN students s ON s.student_id = a.student_id
    WHERE a.quiz_id = ? ORDER BY a.start_time`),
  inProgressAttempts: db.prepare(
    "SELECT * FROM attempts WHERE status = 'IN_PROGRESS'"),
  finalizeAttempt: db.prepare(`
    UPDATE attempts
       SET status = ?, score = ?, correct_count = ?, total_questions = ?,
           answers_json = ?, submission_type = ?, reason = ?,
           submit_time = ?, token = NULL
     WHERE attempt_id = ? AND status = 'IN_PROGRESS'`),
  saveProgress: db.prepare(
    "UPDATE attempts SET answers_json = ? WHERE attempt_id = ? AND status = 'IN_PROGRESS'"),
  bumpViolations: db.prepare(
    'UPDATE attempts SET violations = violations + 1 WHERE attempt_id = ?'),
  deleteAttempt: db.prepare('DELETE FROM attempts WHERE student_id = ? AND quiz_id = ?'),

  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`),

  addFlag: db.prepare(
    'INSERT INTO flags (student_id, quiz_id, reason, severity, created_at) VALUES (?, ?, ?, ?, ?)'),
  flagsByQuiz: db.prepare(
    'SELECT * FROM flags WHERE quiz_id = ? ORDER BY flag_id DESC LIMIT ?'),
  flagsForStudent: db.prepare(
    'SELECT * FROM flags WHERE quiz_id = ? AND student_id = ? ORDER BY flag_id'),
  deleteFlags: db.prepare('DELETE FROM flags WHERE student_id = ? AND quiz_id = ?'),
};

/* ------------------------------------------------------------------ *
 * Row helpers — normalize SQLite ints/JSON into real JS shapes
 * ------------------------------------------------------------------ */

function mapQuiz(row) {
  if (!row) return null;
  return {
    quiz_id: row.quiz_id,
    title: row.title,
    duration_minutes: row.duration_minutes,
    is_active: !!row.is_active,
    shuffle_questions: row.shuffle_questions === undefined ? true : !!row.shuffle_questions,
    created_at: row.created_at,
  };
}

function mapQuestion(row, { includeAnswer = false } = {}) {
  const out = {
    question_id: row.question_id,
    quiz_id: row.quiz_id,
    question_text: row.question_text,
    options: JSON.parse(row.options),
    position: row.position,
    // Only a flag — the image itself is fetched from /api/quiz/image/:id so the
    // exam payload stays small and the browser can cache it.
    has_image: !!row.has_image,
  };
  if (includeAnswer) out.correct_option = row.correct_option;
  return out;
}

module.exports = { db, q, nowIso, mapQuiz, mapQuestion, DB_FILE };
