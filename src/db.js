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

  -- Staff who can create and run their own exams. The administrator is not in
  -- this table: there is exactly one of those, its password comes from the
  -- environment or the settings store, and it is the account that creates these.
  CREATE TABLE IF NOT EXISTS teachers (
    teacher_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT    NOT NULL,
    password_hash TEXT    NOT NULL,        -- scrypt: salt:key, never a plaintext
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT    NOT NULL,
    last_login    TEXT
  );

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
// Gate for a quiz published to the internet: without it, the join URL is the
// only thing between a stranger and a seat in the exam.
addColumn('quizzes', 'access_code', 'TEXT');
// Which teacher owns this quiz. NULL means the administrator created it - which
// is also what every quiz from before this column existed looks like, so those
// stay visible to the admin and to nobody else, rather than being handed to
// whichever teacher happens to log in first.
addColumn('quizzes', 'owner_id', 'INTEGER REFERENCES teachers(teacher_id) ON DELETE SET NULL');

// What each question is worth. REAL rather than INTEGER because half marks are
// ordinary in real papers, and the default of 1 means every question authored
// before this column existed is worth exactly what it was worth before.
addColumn('questions', 'marks', 'REAL NOT NULL DEFAULT 1');

// A finished attempt records marks as well as counts. Both are kept: the marks
// are the result, and the counts are still what an invigilator reads at a glance
// ("8 of 10 right"), which stops being derivable from the marks the moment
// questions are worth different amounts.
addColumn('attempts', 'earned_marks', 'REAL');
addColumn('attempts', 'total_marks', 'REAL');

/**
 * Backfills marks onto attempts recorded before this feature existed.
 *
 * Exact rather than approximate: every question in such a quiz was worth one
 * mark, so the marks earned are precisely the number answered correctly. Doing
 * it once here means nothing downstream has to carry a "what if these are NULL"
 * branch through every score calculation, export and PDF.
 */
db.exec(`
  UPDATE attempts
     SET earned_marks = correct_count, total_marks = total_questions
   WHERE earned_marks IS NULL OR total_marks IS NULL`);

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
  // Kept out of updateQuiz so the code survives every edit that does not
  // deliberately change it - including an activate/deactivate toggle.
  setAccessCode: db.prepare('UPDATE quizzes SET access_code = ? WHERE quiz_id = ?'),

  addQuestion: db.prepare(`
    INSERT INTO questions
      (quiz_id, question_text, options, correct_option, position, image_data, image_mime, marks)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  // Excludes image_data: the blob must never ride along in a JSON payload.
  questionsByQuiz: db.prepare(`
    SELECT question_id, quiz_id, question_text, options, correct_option, position,
           marks, image_mime, (image_data IS NOT NULL) AS has_image
      FROM questions WHERE quiz_id = ? ORDER BY position, question_id`),
  // owner_id rides along so the image route can answer "may this teacher see
  // it?" without a second query on the hot path for every image on the page.
  questionImage: db.prepare(`
    SELECT q.quiz_id, q.image_data, q.image_mime, z.owner_id
      FROM questions q JOIN quizzes z ON z.quiz_id = q.quiz_id
     WHERE q.question_id = ?`),
  // Includes image_data, unlike questionsByQuiz: duplicating a quiz copies the
  // blobs straight across. Server-side only — never hand these rows to JSON.
  questionsForCopy: db.prepare(`
    SELECT question_text, options, correct_option, position, image_data, image_mime, marks
      FROM questions WHERE quiz_id = ? ORDER BY position, question_id`),
  deleteQuestionsByQuiz: db.prepare('DELETE FROM questions WHERE quiz_id = ?'),
  countQuestions: db.prepare('SELECT COUNT(*) AS n FROM questions WHERE quiz_id = ?'),
  // COALESCE so a quiz with no questions yet reports 0 rather than NULL.
  totalMarks: db.prepare(
    'SELECT COALESCE(SUM(marks), 0) AS total FROM questions WHERE quiz_id = ?'),

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
           earned_marks = ?, total_marks = ?,
           answers_json = ?, submission_type = ?, reason = ?,
           submit_time = ?, token = NULL
     WHERE attempt_id = ? AND status = 'IN_PROGRESS'`),
  saveProgress: db.prepare(
    "UPDATE attempts SET answers_json = ? WHERE attempt_id = ? AND status = 'IN_PROGRESS'"),
  bumpViolations: db.prepare(
    'UPDATE attempts SET violations = violations + 1 WHERE attempt_id = ?'),
  deleteAttempt: db.prepare('DELETE FROM attempts WHERE student_id = ? AND quiz_id = ?'),

  /* ---- Teachers ---- */
  createTeacher: db.prepare(`
    INSERT INTO teachers (username, display_name, password_hash, is_active, created_at)
    VALUES (?, ?, ?, 1, ?)`),
  teacherByUsername: db.prepare('SELECT * FROM teachers WHERE username = ?'),
  teacherById: db.prepare('SELECT * FROM teachers WHERE teacher_id = ?'),
  listTeachers: db.prepare(`
    SELECT t.*, (SELECT COUNT(*) FROM quizzes WHERE owner_id = t.teacher_id) AS quiz_count
      FROM teachers t ORDER BY t.display_name COLLATE NOCASE`),
  updateTeacher: db.prepare(
    'UPDATE teachers SET display_name = ?, is_active = ? WHERE teacher_id = ?'),
  updateTeacherPassword: db.prepare(
    'UPDATE teachers SET password_hash = ? WHERE teacher_id = ?'),
  touchTeacherLogin: db.prepare('UPDATE teachers SET last_login = ? WHERE teacher_id = ?'),
  deleteTeacher: db.prepare('DELETE FROM teachers WHERE teacher_id = ?'),

  /* ---- Quiz ownership ---- */
  setQuizOwner: db.prepare('UPDATE quizzes SET owner_id = ? WHERE quiz_id = ?'),
  // Owner name comes along so the admin's quiz list can say who made each one.
  // LEFT JOIN, because an admin-created quiz legitimately has no owner row.
  listQuizzesWithOwner: db.prepare(`
    SELECT q.*, t.display_name AS owner_name
      FROM quizzes q LEFT JOIN teachers t ON t.teacher_id = q.owner_id
     ORDER BY q.quiz_id DESC`),
  listQuizzesByOwner: db.prepare(`
    SELECT q.*, t.display_name AS owner_name
      FROM quizzes q LEFT JOIN teachers t ON t.teacher_id = q.owner_id
     WHERE q.owner_id = ? ORDER BY q.quiz_id DESC`),

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

/**
 * `includeSecret` is opt-in because this shape is returned on the public
 * `/api/quiz/active` route as well as to the admin console. Serialising
 * access_code by default would publish the code to exactly the people it exists
 * to keep out, so callers must ask for it and only admin routes do.
 */
function mapQuiz(row, { includeSecret = false } = {}) {
  if (!row) return null;
  const code = String(row.access_code || '').trim();
  const quiz = {
    quiz_id: row.quiz_id,
    title: row.title,
    duration_minutes: row.duration_minutes,
    is_active: !!row.is_active,
    shuffle_questions: row.shuffle_questions === undefined ? true : !!row.shuffle_questions,
    requires_code: !!code,
    owner_id: row.owner_id === undefined ? null : row.owner_id,
    owner_name: row.owner_name || null,
    created_at: row.created_at,
  };
  if (includeSecret) quiz.access_code = code || null;
  return quiz;
}

function mapQuestion(row, { includeAnswer = false } = {}) {
  const out = {
    question_id: row.question_id,
    quiz_id: row.quiz_id,
    question_text: row.question_text,
    options: JSON.parse(row.options),
    position: row.position,
    // Sent to students as well as staff: somebody sitting a paper is entitled to
    // know what each question is worth before deciding where to spend the time.
    marks: row.marks === undefined || row.marks === null ? 1 : row.marks,
    // Only a flag — the image itself is fetched from /api/quiz/image/:id so the
    // exam payload stays small and the browser can cache it.
    has_image: !!row.has_image,
  };
  if (includeAnswer) out.correct_option = row.correct_option;
  return out;
}

module.exports = { db, q, nowIso, mapQuiz, mapQuestion, DB_FILE };
