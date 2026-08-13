'use strict';

/**
 * Loads a demo quiz and a small student roster so the system can be tried out
 * end-to-end straight away. Safe to re-run: it never touches existing quizzes.
 *
 *   npm run seed
 */

const { q, nowIso } = require('../src/db');

const QUIZ = {
  title: 'Demo Exam — General Knowledge',
  durationMinutes: 10,
  questions: [
    {
      text: 'Which protocol does the exam client use for real-time invigilation events?',
      options: ['FTP', 'WebSockets', 'SMTP', 'SNMP'],
      correct: 1,
    },
    {
      text: 'What does the Page Visibility API let a web page detect?',
      options: [
        'The screen resolution of the device',
        'Whether the page is hidden, e.g. by a tab switch',
        'The battery level of the device',
        'The list of installed browser extensions',
      ],
      correct: 1,
    },
    {
      text: 'Which HTTP status code means "Forbidden"?',
      options: ['301', '401', '403', '503'],
      correct: 2,
    },
    {
      text: 'In an IPv4 address like 192.168.1.100, what does 192.168.x.x indicate?',
      options: [
        'A public internet address',
        'A private LAN address range',
        'A multicast address',
        'A loopback address',
      ],
      correct: 1,
    },
    {
      text: 'Which SQLite journal mode improves concurrent reads during writes?',
      options: ['DELETE', 'TRUNCATE', 'WAL', 'MEMORY'],
      correct: 2,
    },
  ],
};

const STUDENTS = [
  ['CSE-001', 'Aarav Sharma'],
  ['CSE-002', 'Beatrice Okafor'],
  ['CSE-003', 'Chen Wei'],
  ['CSE-004', 'Diego Ramirez'],
  ['CSE-005', 'Elena Petrova'],
];

function main() {
  const existing = q.listQuizzes.all()
    .find((row) => row.title === QUIZ.title);

  if (existing) {
    console.log(`  Demo quiz already present (quiz_id ${existing.quiz_id}) — skipping quiz.`);
  } else {
    const info = q.createQuiz.run(QUIZ.title, QUIZ.durationMinutes, 0, nowIso());
    const quizId = Number(info.lastInsertRowid);
    QUIZ.questions.forEach((item, index) => {
      q.addQuestion.run(quizId, item.text, JSON.stringify(item.options), item.correct, index);
    });
    console.log(`  Created quiz "${QUIZ.title}" (quiz_id ${quizId}) `
      + `with ${QUIZ.questions.length} questions.`);
  }

  for (const [id, name] of STUDENTS) {
    q.upsertStudent.run(id, name, nowIso());
  }
  console.log(`  Roster ready: ${STUDENTS.length} students.`);
  console.log('\n  Next: npm start  ->  open the admin console and activate the quiz.\n');
}

main();
