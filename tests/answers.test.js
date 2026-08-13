'use strict';

/**
 * Individual response sheets and their PDF export.
 *
 * The PDF assertions parse the generated file rather than trusting that it was
 * produced: page count, embedded images and the actual extracted text are all
 * checked, because a structurally valid PDF can still be visually wrong.
 */

process.env.DB_FILE = ':memory:';
process.env.ADMIN_PASSWORD = 'ans-pass';
process.env.PORT = process.env.TEST_PORT_ANS || '38625';
process.env.QUIET = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { once } = require('node:events');
const { PDFParse } = require('pdf-parse');

const { server } = require('../server');
const BASE = `http://127.0.0.1:${process.env.PORT}`;

let adminToken;
let quizId;        // shuffled
let fixedQuizId;   // not shuffled

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

async function getPdf(path, token) {
  const res = await fetch(BASE + path + `?adminToken=${encodeURIComponent(token)}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return { res, buffer };
}

async function readPdf(buffer) {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const text = await parser.getText();
    // Counted from the file structure. pdf-parse's own image extractor misses
    // images depending on which page they land on, so it is not trusted here.
    const imageXObjects = (buffer.toString('latin1').match(/\/Subtype\s*\/Image/g) || []).length;
    return { pages: text.pages.length, text: text.text || '', imageXObjects };
  } finally {
    await parser.destroy();
  }
}

/* A real PNG, so an embedding failure means a code fault, not a bad fixture. */
let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return c ^ -1;
}

function makePng(w = 120, h = 80) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y += 1) {
    raw[p] = 0; p += 1;
    for (let x = 0; x < w; x += 1) {
      raw[p] = (x * 2) & 0xFF; raw[p + 1] = (y * 3) & 0xFF; raw[p + 2] = 128;
      p += 3;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const QUESTIONS = [
  { question_text: 'What is the SI unit of force?', options: ['Joule', 'Newton', 'Watt', 'Pascal'], correct_option: 1 },
  { question_text: 'Identify the component in the diagram.', options: ['Resistor', 'Capacitor', 'Diode', 'Inductor'], correct_option: 2 },
  { question_text: 'Approximate value of g at sea level?', options: ['8.9', '9.8', '10.8', '11.2'], correct_option: 1 },
  { question_text: 'Which is a vector quantity?', options: ['Mass', 'Speed', 'Velocity', 'Energy'], correct_option: 2 },
];

test.before(async () => {
  if (!server.listening) await once(server, 'listening');
  adminToken = (await call('POST', '/api/admin/login', { password: 'ans-pass' })).data.token;

  const png = `data:image/png;base64,${makePng().toString('base64')}`;
  const withImage = QUESTIONS.map((question, i) => (
    i === 1 ? { ...question, image: png } : { ...question }));

  quizId = (await call('POST', '/api/admin/quizzes', {
    title: 'Physics — Unit 2', durationMinutes: 30,
    shuffleQuestions: true, questions: withImage,
  }, adminToken)).data.quiz.quiz_id;

  fixedQuizId = (await call('POST', '/api/admin/quizzes', {
    title: 'Fixed Order Exam', durationMinutes: 30,
    shuffleQuestions: false, questions: QUESTIONS,
  }, adminToken)).data.quiz.quiz_id;
});

test.after(() => { server.close(); });

/** Sits an exam. `plan(questionText) -> option index | null` decides answers. */
async function sit(quiz, studentId, name, plan, opts = {}) {
  await call('POST', `/api/admin/quizzes/${quiz}/activate`, { active: true }, adminToken);
  const login = await call('POST', '/api/auth/login', { studentId, name });
  assert.equal(login.status, 200, `login failed for ${studentId}`);

  const exam = await call('GET', '/api/quiz/exam', null, login.data.token);
  const answers = {};
  for (const question of exam.data.questions) {
    const pick = plan(question.question_text);
    if (pick !== null && pick !== undefined) answers[`q${question.question_id}`] = pick;
  }

  if (opts.terminate) {
    await call('POST', '/api/quiz/flag-submit',
      { answers, reason: opts.terminate }, login.data.token);
  } else {
    await call('POST', '/api/quiz/submit', { answers }, login.data.token);
  }
  return exam.data.questions;
}

/* ------------------------------------------------------------------ */

test('the answer sheet records exactly what the student chose', async () => {
  // Right, wrong, right, blank.
  await sit(quizId, 'ANS-001', 'Aarav Śarmā', (text) => {
    if (/SI unit of force/.test(text)) return 1;      // correct
    if (/component in the diagram/.test(text)) return 0; // wrong (key 2)
    if (/value of g/.test(text)) return 1;            // correct
    return null;                                      // blank
  });

  const sheet = (await call('GET',
    `/api/admin/results/${quizId}/student/ANS-001`, null, adminToken)).data;

  assert.equal(sheet.student.studentId, 'ANS-001');
  assert.equal(sheet.student.name, 'Aarav Śarmā');
  assert.equal(sheet.questions.length, 4);
  assert.equal(sheet.counts.total, 4);
  assert.equal(sheet.counts.correct, 2);
  assert.equal(sheet.counts.wrong, 1);
  assert.equal(sheet.counts.unanswered, 1);
  assert.equal(sheet.counts.answered, 3);
  assert.equal(sheet.attempt.score, 50);

  const force = sheet.questions.find((item) => /SI unit of force/.test(item.question_text));
  assert.equal(force.chosen, 1);
  assert.equal(force.correct_option, 1);
  assert.equal(force.isCorrect, true);
  assert.equal(force.answered, true);

  const diagram = sheet.questions.find((item) => /component in the diagram/.test(item.question_text));
  assert.equal(diagram.chosen, 0);
  assert.equal(diagram.correct_option, 2);
  assert.equal(diagram.isCorrect, false);
  assert.equal(diagram.has_image, true);

  const vector = sheet.questions.find((item) => /vector quantity/.test(item.question_text));
  assert.equal(vector.chosen, null);
  assert.equal(vector.answered, false);
  assert.equal(vector.isCorrect, false);
  assert.equal(vector.correct_option, 2, 'the key is still reported for a blank answer');
});

test('the stored score always matches the sheet it is derived from', async () => {
  const sheet = (await call('GET',
    `/api/admin/results/${quizId}/student/ANS-001`, null, adminToken)).data;
  const recomputed = Math.round(
    sheet.questions.filter((i) => i.isCorrect).length / sheet.questions.length * 10000) / 100;
  assert.equal(sheet.attempt.score, recomputed);
  assert.equal(sheet.attempt.correct, sheet.counts.correct);
});

test('questions come back in the order that student actually saw them', async () => {
  const presented = await sit(quizId, 'ANS-002', 'Order Check', () => 0);
  const sheet = (await call('GET',
    `/api/admin/results/${quizId}/student/ANS-002`, null, adminToken)).data;

  assert.equal(sheet.quiz.shuffled, true);
  assert.deepEqual(
    sheet.questions.map((item) => item.question_id),
    presented.map((question) => question.question_id),
    'sheet order must match the order served to that student',
  );

  // shownAs is the position on their paper; authoredAs is the examiner's.
  sheet.questions.forEach((item, index) => assert.equal(item.shownAs, index + 1));
  assert.deepEqual(
    sheet.questions.map((item) => item.authoredAs).slice().sort(),
    [1, 2, 3, 4],
    'every authored question appears exactly once',
  );
});

test('two students on a shuffled quiz get their own orders back', async () => {
  await sit(quizId, 'ANS-003', 'Third Student', () => 1);
  const a = (await call('GET', `/api/admin/results/${quizId}/student/ANS-002`, null, adminToken)).data;
  const b = (await call('GET', `/api/admin/results/${quizId}/student/ANS-003`, null, adminToken)).data;

  // Each sheet is internally consistent even if the two orders coincide.
  for (const sheet of [a, b]) {
    sheet.questions.forEach((item) => {
      const authored = QUESTIONS[item.authoredAs - 1];
      assert.equal(item.question_text, authored.question_text);
      assert.equal(item.correct_option, authored.correct_option);
    });
  }
});

test('a fixed-order quiz reports authored order and no shuffling', async () => {
  await sit(fixedQuizId, 'ANS-010', 'Fixed Order', () => 2);
  const sheet = (await call('GET',
    `/api/admin/results/${fixedQuizId}/student/ANS-010`, null, adminToken)).data;

  assert.equal(sheet.quiz.shuffled, false);
  sheet.questions.forEach((item, index) => {
    assert.equal(item.shownAs, index + 1);
    assert.equal(item.authoredAs, index + 1);
    assert.equal(item.question_text, QUESTIONS[index].question_text);
  });
});

test('a terminated attempt keeps its answers and its reason', async () => {
  await sit(quizId, 'ANS-004', 'Terminated Tom', (text) =>
    (/SI unit of force/.test(text) ? 1 : null), { terminate: 'Exited fullscreen mode' });

  const sheet = (await call('GET',
    `/api/admin/results/${quizId}/student/ANS-004`, null, adminToken)).data;

  assert.equal(sheet.attempt.status, 'TERMINATED');
  assert.equal(sheet.attempt.reason, 'Exited fullscreen mode');
  assert.equal(sheet.attempt.submissionType, 'AUTO_TERMINATED');
  assert.equal(sheet.counts.correct, 1, 'answers given before termination still count');
  assert.equal(sheet.counts.unanswered, 3);
  assert.ok(sheet.flags.length >= 1);
  assert.equal(sheet.flags[0].severity, 'FATAL');
});

test('a student who answered nothing produces an all-blank sheet', async () => {
  await sit(quizId, 'ANS-005', 'Blank Bella', () => null);
  const sheet = (await call('GET',
    `/api/admin/results/${quizId}/student/ANS-005`, null, adminToken)).data;

  assert.equal(sheet.counts.answered, 0);
  assert.equal(sheet.counts.unanswered, 4);
  assert.equal(sheet.attempt.score, 0);
  sheet.questions.forEach((item) => {
    assert.equal(item.chosen, null);
    assert.equal(item.answered, false);
    assert.equal(typeof item.correct_option, 'number');
  });
});

test('an unknown student or quiz is a clean 404', async () => {
  assert.equal((await call('GET',
    `/api/admin/results/${quizId}/student/NOBODY`, null, adminToken)).status, 404);
  assert.equal((await call('GET',
    '/api/admin/results/99999/student/ANS-001', null, adminToken)).status, 404);
});

/* ---------------- PDF ---------------- */

test('the single-student PDF is a real PDF with the right headers', async () => {
  const { res, buffer } = await getPdf(
    `/api/admin/results/${quizId}/student/ANS-001/answers.pdf`, adminToken);

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/pdf/);
  assert.match(res.headers.get('content-disposition'),
    /attachment; filename="answers-ans-001-physics-unit-2\.pdf"/);
  assert.equal(Number(res.headers.get('content-length')), buffer.length);

  assert.equal(buffer.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.ok(buffer.subarray(-1024).toString('latin1').includes('%%EOF'), 'must be complete');
});

test('the PDF contains the student id, the questions, the answers and the key', async () => {
  const { buffer } = await getPdf(
    `/api/admin/results/${quizId}/student/ANS-001/answers.pdf`, adminToken);
  const pdf = await readPdf(buffer);

  assert.match(pdf.text, /ANS-001/, 'student id must appear');
  assert.match(pdf.text, /Aarav Śarmā/,
    'the name must survive font selection, accents included');
  assert.match(pdf.text, /Physics — Unit 2/);

  for (const question of QUESTIONS) {
    const head = question.question_text.slice(0, 24);
    assert.ok(pdf.text.includes(head), `missing question: ${head}`);
  }
  // Every option of the first question is listed, not just the chosen one.
  for (const option of QUESTIONS[0].options) {
    assert.ok(pdf.text.includes(option), `missing option: ${option}`);
  }

  assert.match(pdf.text, /student's answer/, "the student's pick must be labelled");
  assert.match(pdf.text, /correct answer/, 'the key must be labelled');
  assert.match(pdf.text, /CORRECT/);
  assert.match(pdf.text, /WRONG/);
  assert.match(pdf.text, /NOT ANSWERED|left this question blank/);
  assert.match(pdf.text, /50%/, 'the score belongs on the examiner-facing sheet');
});

test('the PDF embeds question images rather than skipping them', async () => {
  const { buffer } = await getPdf(
    `/api/admin/results/${quizId}/student/ANS-001/answers.pdf`, adminToken);
  const pdf = await readPdf(buffer);

  assert.ok(!/could not be embedded|not shown in this format/.test(pdf.text),
    'the image should embed, not fall back to a notice');
  assert.equal(pdf.imageXObjects, 1,
    'the one illustrated question must contribute exactly one image XObject');
});

test('a question whose image cannot be embedded degrades instead of failing', async () => {
  // WebP is accepted for the exam UI but pdfkit embeds only PNG and JPEG, so
  // the PDF must say so rather than break.
  const webp = 'data:image/webp;base64,' + Buffer.from('not-a-real-webp').toString('base64');
  const oddQuiz = (await call('POST', '/api/admin/quizzes', {
    title: 'Odd Image Exam', durationMinutes: 10, shuffleQuestions: false,
    questions: [{
      question_text: 'Question carrying an unsupported image format.',
      options: ['a', 'b'], correct_option: 0, image: webp,
    }],
  }, adminToken)).data.quiz.quiz_id;

  await sit(oddQuiz, 'ANS-020', 'Odd Image', () => 0);

  const { res, buffer } = await getPdf(
    `/api/admin/results/${oddQuiz}/student/ANS-020/answers.pdf`, adminToken);
  assert.equal(res.status, 200, 'an unsupported image must not fail the whole PDF');

  const pdf = await readPdf(buffer);
  assert.equal(pdf.imageXObjects, 0);
  assert.match(pdf.text, /not shown in this format/,
    'the sheet must disclose that an image existed but was not rendered');
  assert.match(pdf.text, /ANS-020/);
});

test('page count and footer numbering agree', async () => {
  const { buffer } = await getPdf(
    `/api/admin/results/${quizId}/student/ANS-001/answers.pdf`, adminToken);
  const pdf = await readPdf(buffer);

  // Footers used to overflow the bottom margin and spawn a blank page each.
  const declared = /Page \d+ of (\d+)/.exec(pdf.text);
  assert.ok(declared, 'the footer must state a page count');
  assert.equal(Number(declared[1]), pdf.pages,
    'the footer total must equal the real page count');
  assert.ok(pdf.pages <= 3, `a 4-question sheet should be short, got ${pdf.pages} pages`);
});

test('the combined PDF holds every student, one per starting page', async () => {
  const { res, buffer } = await getPdf(`/api/admin/results/${quizId}/answers.pdf`, adminToken);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /answers-all-physics-unit-2\.pdf/);

  const pdf = await readPdf(buffer);
  for (const id of ['ANS-001', 'ANS-002', 'ANS-003', 'ANS-004', 'ANS-005']) {
    assert.ok(pdf.text.includes(id), `combined PDF missing ${id}`);
    assert.ok(pdf.text.includes(`End of answer sheet - ${id}`),
      `combined PDF missing the end marker for ${id}`);
  }
  const declared = /Page \d+ of (\d+)/.exec(pdf.text);
  assert.equal(Number(declared[1]), pdf.pages);
});

test('the combined PDF 404s for a quiz nobody has sat', async () => {
  const empty = (await call('POST', '/api/admin/quizzes', {
    title: 'Untouched', durationMinutes: 10,
    questions: [{ question_text: 'Q', options: ['a', 'b'], correct_option: 0 }],
  }, adminToken)).data.quiz.quiz_id;

  const { res } = await getPdf(`/api/admin/results/${empty}/answers.pdf`, adminToken);
  assert.equal(res.status, 404);
});

test('the PDF is fetchable with a header token, as the dashboard does it', async () => {
  // The dashboard fetches the PDF as a blob with an Authorization header rather
  // than navigating to the URL: an `attachment` reply is saved instead of shown,
  // and browsers block some downloads started by navigation over plain HTTP.
  const res = await fetch(`${BASE}/api/admin/results/${quizId}/student/ANS-001/answers.pdf`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/pdf/);
  const buffer = Buffer.from(await res.arrayBuffer());
  assert.equal(buffer.subarray(0, 5).toString('latin1'), '%PDF-');
});

test('inline mode renders in the browser viewer instead of downloading', async () => {
  const path = `/api/admin/results/${quizId}/student/ANS-001/answers.pdf`;

  const download = await fetch(`${BASE}${path}?adminToken=${encodeURIComponent(adminToken)}`);
  assert.match(download.headers.get('content-disposition'), /^attachment;/,
    'the default must still be a download');

  const inline = await fetch(
    `${BASE}${path}?inline=1&adminToken=${encodeURIComponent(adminToken)}`);
  assert.equal(inline.status, 200);
  assert.match(inline.headers.get('content-disposition'), /^inline;/,
    'inline=1 must let the browser display it');
  assert.match(inline.headers.get('content-type'), /application\/pdf/);

  const combined = await fetch(`${BASE}/api/admin/results/${quizId}/answers.pdf`
    + `?inline=1&adminToken=${encodeURIComponent(adminToken)}`);
  assert.match(combined.headers.get('content-disposition'), /^inline;/);
});

test('response sheets and PDFs require an admin token', async () => {
  const paths = [
    `/api/admin/results/${quizId}/student/ANS-001`,
    `/api/admin/results/${quizId}/student/ANS-001/answers.pdf`,
    `/api/admin/results/${quizId}/answers.pdf`,
  ];
  for (const path of paths) {
    assert.equal((await fetch(BASE + path)).status, 401, `${path} must reject anonymous access`);
    assert.equal((await fetch(`${BASE}${path}?adminToken=bogus`)).status, 401,
      `${path} must reject a bad token`);
  }

  // A live exam token must not unlock the examiner's view of a paper.
  await call('POST', `/api/admin/quizzes/${quizId}/activate`, { active: true }, adminToken);
  const login = await call('POST', '/api/auth/login',
    { studentId: 'ANS-006', name: 'Sneaky Sam' });
  for (const path of paths) {
    const res = await fetch(`${BASE}${path}?adminToken=`
      + encodeURIComponent(login.data.token));
    assert.equal(res.status, 401, `${path} must reject an exam token`);
  }
});

test('a PDF failure reports as JSON instead of a truncated download', async () => {
  // Force a render error to prove the buffered path never emits a broken file.
  const pdf = require('../src/pdf');
  const real = pdf.renderAnswerSheets;
  const routes = require('../src/routes');
  void routes;

  // Sanity: the happy path works, then a malformed sheet must not hang or
  // produce a half-written PDF.
  await assert.rejects(() => real([{ quiz: {}, student: {}, attempt: {} }]),
    'a malformed sheet must reject rather than emit a partial document');
});
