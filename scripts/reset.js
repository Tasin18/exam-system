'use strict';

/**
 * Clears attempts and violation flags so a quiz can be re-run with the same
 * roster. Quizzes, questions and students are kept.
 *
 *   npm run reset            clear every attempt
 *   npm run reset -- 3       clear attempts for quiz_id 3 only
 */

const { db } = require('../src/db');

const target = process.argv[2] ? Number(process.argv[2]) : null;

if (target !== null && !Number.isInteger(target)) {
  console.error('  Usage: npm run reset -- <quizId>');
  process.exit(1);
}

if (target === null) {
  const attempts = db.prepare('DELETE FROM attempts').run();
  const flags = db.prepare('DELETE FROM flags').run();
  console.log(`  Cleared ${attempts.changes} attempt(s) and ${flags.changes} flag(s) `
    + 'across all quizzes.');
} else {
  const attempts = db.prepare('DELETE FROM attempts WHERE quiz_id = ?').run(target);
  const flags = db.prepare('DELETE FROM flags WHERE quiz_id = ?').run(target);
  console.log(`  Cleared ${attempts.changes} attempt(s) and ${flags.changes} flag(s) `
    + `for quiz_id ${target}.`);
}
