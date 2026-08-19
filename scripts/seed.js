'use strict';

/**
 * Loads a demo quiz and a small student roster so the system can be tried out
 * end-to-end straight away. Safe to re-run: it never touches existing quizzes.
 *
 *   npm run seed
 */

const { q, nowIso } = require('../src/db');
const auth = require('../src/auth');
const { INTERNET_MODE } = require('../src/origin');

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

/**
 * A teacher account, so `/teacher` is usable straight after seeding.
 *
 * Only ever created on a LAN. On a public deployment a demo login with a
 * published password is a door left standing open, and the administrator can
 * create a real account in the console in a few seconds.
 */
function seedTeacher() {
  if (INTERNET_MODE) {
    console.log('  Skipping the demo teacher: this deployment is public. Create');
    console.log('  real accounts in the admin console instead.');
    return;
  }
  if (q.teacherByUsername.get('demo')) {
    console.log('  Demo teacher already present (demo) - skipping.');
    return;
  }
  auth.createTeacher({
    username: 'demo', displayName: 'Demo Teacher', password: 'demo-password',
  });
  console.log('  Created teacher "demo" (password: demo-password) for /teacher.');
}

function main() {
  const existing = q.listQuizzes.all()
    .find((row) => row.title === QUIZ.title);

  if (existing) {
    console.log(`  Demo quiz already present (quiz_id ${existing.quiz_id}) — skipping quiz.`);
  } else {
    // Five columns since shuffle_questions was added; this call still passed
    // four, so seeding failed outright on a NOT NULL constraint.
    const info = q.createQuiz.run(
      QUIZ.title, QUIZ.durationMinutes, 0, 1, nowIso());
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
  // Worth saying plainly: the live monitor lists the people sitting an exam, so
  // these names appear there only once they actually log in.
  console.log(`  Roster ready: ${STUDENTS.length} students `
    + '(they show on the Live Monitor once they log in).');

  seedTeacher();

  console.log('\n  Next: npm start');
  console.log('    /admin   - administrator: everything, plus teacher accounts');
  console.log('    /teacher - teacher panel: sign in as  demo / demo-password\n');
}

main();
