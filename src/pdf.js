'use strict';

const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');
const fontkit = require('fontkit');
const { q } = require('./db');

/* ------------------------------------------------------------------ *
 * Fonts
 *
 * PDF's built-in Helvetica only covers WinAnsi, so anything outside Latin-1
 * (Bengali, Devanagari, CJK, curly quotes) would silently come out wrong on an
 * official answer sheet. Instead the font is chosen from what the document
 * actually contains: the first candidate that covers every character wins.
 * ------------------------------------------------------------------ */

const FONT_DIR = process.env.WINDIR
  ? path.join(process.env.WINDIR, 'Fonts')
  : '/usr/share/fonts';

const CANDIDATES = [
  // Widest scripts first — Nirmala adds the Indic families to Latin.
  { name: 'Nirmala UI', regular: 'nirmala.ttf', bold: 'nirmalab.ttf' },
  { name: 'Arial', regular: 'arial.ttf', bold: 'arialbd.ttf' },
  { name: 'Segoe UI', regular: 'segoeui.ttf', bold: 'segoeuib.ttf' },
  { name: 'DejaVu Sans', regular: 'DejaVuSans.ttf', bold: 'DejaVuSans-Bold.ttf' },
  { name: 'Liberation Sans', regular: 'LiberationSans-Regular.ttf', bold: 'LiberationSans-Bold.ttf' },
];

const coverageCache = new Map();

function loadCoverage(file) {
  if (coverageCache.has(file)) return coverageCache.get(file);
  const full = path.join(FONT_DIR, file);
  let font = null;
  try {
    if (fs.existsSync(full)) font = fontkit.openSync(full);
  } catch { font = null; }
  const entry = font && typeof font.hasGlyphForCodePoint === 'function'
    ? { path: full, font }
    : null;
  coverageCache.set(file, entry);
  return entry;
}

/** Distinct code points in a string, ignoring whitespace we control. */
function codePointsOf(text, into) {
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (cp === 10 || cp === 13 || cp === 9 || cp === 32) continue;
    into.add(cp);
  }
  return into;
}

/**
 * Picks the best available font pair for a given set of text.
 *
 * Chosen per string rather than per document: no single Windows font covers
 * both Indic and Latin-Extended, so a paper mixing "Aarav Śarmā" with Bengali
 * question text needs Arial for one line and Nirmala for the next. Each
 * .text() call is a separate run, so the font can change between them.
 *
 * Returns { name, regular, bold, missing } — `missing` are code points no
 * candidate could draw, which the caller substitutes rather than mangles.
 */
function chooseFont(texts) {
  const needed = new Set();
  (Array.isArray(texts) ? texts : [texts]).forEach((t) => codePointsOf(t, needed));

  let best = null;
  for (const candidate of CANDIDATES) {
    const regular = loadCoverage(candidate.regular);
    if (!regular) continue;
    const missing = [...needed].filter((cp) => !regular.font.hasGlyphForCodePoint(cp));
    const bold = loadCoverage(candidate.bold);
    const pick = {
      name: candidate.name,
      regular: regular.path,
      bold: bold ? bold.path : regular.path,
      missing: new Set(missing),
    };
    if (!missing.length) return pick;
    if (!best || missing.length < best.missing.size) best = pick;
  }

  // No usable TTF on this machine — fall back to the built-in font. Only
  // Latin-1 survives, so everything else is flagged for substitution.
  if (!best) {
    const missing = [...needed].filter((cp) => cp > 0xFF);
    return { name: 'Helvetica', regular: null, bold: null, missing: new Set(missing) };
  }
  return best;
}

// Per-string picks repeat constantly (every option, every heading), so memoize.
const pickCache = new Map();

function fontFor(text) {
  const key = String(text);
  if (pickCache.has(key)) return pickCache.get(key);
  const pick = chooseFont([key]);
  if (pickCache.size < 5000) pickCache.set(key, pick);
  return pick;
}

/* ------------------------------------------------------------------ *
 * Layout constants
 * ------------------------------------------------------------------ */

const PAGE = { size: 'A4', margin: 46 };
/** 2 -> "2", 2.5 -> "2.5". Trailing zeros make a mark scheme read like a ledger. */
function fmtMarks(value) {
  const n = Number(value || 0);
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

const COLOR = {
  text: '#16202e',
  muted: '#5c6a7e',
  rule: '#dfe5ee',
  correct: '#17795e',
  wrong: '#b3261e',
  accent: '#2f5fe0',
  panel: '#f6f8fb',
};
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

const fmtStamp = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-GB', { hour12: false });
};

/* ------------------------------------------------------------------ *
 * Renderer
 * ------------------------------------------------------------------ */

class SheetWriter {
  constructor(doc, font) {
    this.doc = doc;
    this.font = font;
    // The document is created with autoFirstPage:false, so there is no page to
    // measure yet. Width is set from the real page once one exists.
    this.contentWidth = 0;
    this.substituted = 0;
  }

  syncPageWidth() {
    this.contentWidth = this.doc.page.width - PAGE.margin * 2;
  }

  /**
   * Replaces characters a font cannot draw. The substitute is '?' rather than
   * U+FFFD because the replacement glyph itself is absent from many fonts —
   * using it just produced a second blank.
   */
  static sanitize(text, font) {
    const value = String(text === null || text === undefined ? '' : text);
    if (!font.missing.size) return value;
    let out = '';
    for (const ch of value) {
      out += font.missing.has(ch.codePointAt(0)) ? '?' : ch;
    }
    return out;
  }

  /** Sanitizes against the document default font (for chrome and labels). */
  safe(text) {
    return SheetWriter.sanitize(text, this.font);
  }

  /**
   * Selects the best font for this specific string, applies it, and returns the
   * string ready to draw. Must be called before heightOfString so measurement
   * and drawing use the same font.
   */
  content(text, size, isBold) {
    const value = String(text === null || text === undefined ? '' : text);
    const font = fontFor(value);
    const file = isBold ? font.bold : font.regular;
    this.doc.font(file || (isBold ? 'Helvetica-Bold' : 'Helvetica')).fontSize(size);
    if (font.missing.size) this.substituted += 1;
    return SheetWriter.sanitize(value, font);
  }

  // Both return the pdfkit document so calls chain into .fillColor().text().
  regular(size) {
    this.doc.font(this.font.regular || 'Helvetica').fontSize(size);
    return this.doc;
  }

  bold(size) {
    this.doc.font(this.font.bold || 'Helvetica-Bold').fontSize(size);
    return this.doc;
  }

  /** Starts a new page when `needed` points would overflow the body area. */
  ensure(needed) {
    const limit = this.doc.page.height - PAGE.margin - 26; // leave room for the footer
    if (this.doc.y + needed <= limit) return false;
    this.doc.addPage();
    return true;
  }

  rule(gap = 8) {
    this.doc.moveTo(PAGE.margin, this.doc.y + gap / 2)
      .lineTo(PAGE.margin + this.contentWidth, this.doc.y + gap / 2)
      .lineWidth(0.7).strokeColor(COLOR.rule).stroke();
    this.doc.y += gap;
  }

  /* ---------------- header ---------------- */

  header(sheet) {
    const { doc } = this;

    const title = this.content(sheet.quiz.title, 17, true);
    doc.fillColor(COLOR.text)
      .text(title, PAGE.margin, PAGE.margin, { width: this.contentWidth });
    this.regular(10).fillColor(COLOR.muted).text('Answer Sheet', { width: this.contentWidth });
    doc.y += 8;

    // Identity block — the student ID is the point of this document, so it is
    // the largest thing on the page after the exam title.
    const boxTop = doc.y;
    const boxHeight = 74;
    doc.roundedRect(PAGE.margin, boxTop, this.contentWidth, boxHeight, 5)
      .fillAndStroke(COLOR.panel, COLOR.rule);

    const colX = PAGE.margin + 14;
    doc.y = boxTop + 11;
    this.regular(8).fillColor(COLOR.muted)
      .text('STUDENT ID', colX, doc.y, { characterSpacing: 0.6 });
    const sid = this.content(sheet.student.studentId, 19, true);
    doc.fillColor(COLOR.text).text(sid, colX, doc.y + 1);
    const who = this.content(sheet.student.name, 10.5, false);
    doc.fillColor(COLOR.text).text(who, colX, doc.y + 2);

    // Right-hand summary column.
    const rightX = PAGE.margin + this.contentWidth / 2 + 10;
    const rightW = this.contentWidth / 2 - 24;
    const terminated = sheet.attempt.status === 'TERMINATED';
    const statusLabel = terminated ? 'AUTO-TERMINATED' : sheet.attempt.status.replace(/_/g, ' ');

    doc.y = boxTop + 11;
    this.regular(8).fillColor(COLOR.muted).text('RESULT', rightX, doc.y, { width: rightW });
    // Marks lead, because that is the figure that gets transcribed into a
    // register. The percentage follows it, and the question count sits under
    // both - with weighted questions it no longer implies the mark.
    this.bold(19).fillColor(terminated ? COLOR.wrong : COLOR.correct)
      .text(`${fmtMarks(sheet.counts.earnedMarks)} / ${fmtMarks(sheet.counts.totalMarks)}`,
        rightX, doc.y + 1, { width: rightW });
    this.bold(10).fillColor(terminated ? COLOR.wrong : COLOR.correct)
      .text(`${sheet.attempt.score}%`, rightX, doc.y + 1, { width: rightW });
    this.regular(9.5).fillColor(COLOR.text).text(
      `${sheet.counts.correct} of ${sheet.counts.total} questions correct`
      + `   |   ${statusLabel}`, rightX, doc.y + 2, { width: rightW });

    doc.y = boxTop + boxHeight + 12;

    // Metadata line.
    this.regular(8.6).fillColor(COLOR.muted);
    const meta = [
      `Started ${fmtStamp(sheet.attempt.startTime)}`,
      `Submitted ${fmtStamp(sheet.attempt.submitTime)}`,
      `Answered ${sheet.counts.answered}/${sheet.counts.total}`,
      `Paper total ${fmtMarks(sheet.counts.totalMarks)} marks`,
      sheet.counts.unanswered ? `Blank ${sheet.counts.unanswered}` : null,
      sheet.attempt.violations ? `Violations ${sheet.attempt.violations}` : null,
    ].filter(Boolean).join('     ');
    doc.text(this.safe(meta), PAGE.margin, doc.y, { width: this.contentWidth });

    if (sheet.quiz.shuffled) {
      doc.text('Questions are listed in the randomized order this student saw them; '
        + 'the examiner\'s original numbering is shown in brackets.',
      PAGE.margin, doc.y + 2, { width: this.contentWidth });
    }

    if (terminated && sheet.attempt.reason) {
      doc.y += 6;
      const h = 20;
      doc.roundedRect(PAGE.margin, doc.y, this.contentWidth, h, 4)
        .fillAndStroke('#fdeceb', '#f5cdc9');
      const why = this.content(`Terminated: ${sheet.attempt.reason}`, 9, true);
      doc.fillColor(COLOR.wrong)
        .text(why, PAGE.margin + 9, doc.y + 6, { width: this.contentWidth - 18 });
      doc.y += 6;
    }

    doc.y += 4;
    this.rule(10);
  }

  /* ---------------- one question ---------------- */

  question(item) {
    const { doc } = this;
    const bodyWidth = this.contentWidth - 22;

    // Measure first so a question is never split across a page break. Each
    // string is measured under the font it will actually be drawn with.
    const bodyText = this.content(item.question_text, 10.5, false);
    const textHeight = doc.heightOfString(bodyText, { width: bodyWidth });

    let imageHeight = 0;
    let image = null;
    if (item.has_image) {
      image = this.loadImage(item.question_id);
      if (image) imageHeight = image.height + 8;
    }

    const optionText = item.options.map((option) => this.content(option, 10, false));
    const optionHeights = item.options.map((option, index) => {
      this.content(option, 10, false);
      return Math.max(15, doc.heightOfString(optionText[index], { width: bodyWidth - 26 }) + 5);
    });
    const optionsHeight = optionHeights.reduce((a, b) => a + b, 0);

    this.ensure(textHeight + imageHeight + optionsHeight + 42);

    const top = doc.y;

    // Number + verdict badge.
    const label = item.answered
      ? (item.isCorrect ? 'CORRECT' : 'WRONG')
      : 'NOT ANSWERED';
    const labelColor = item.answered
      ? (item.isCorrect ? COLOR.correct : COLOR.wrong)
      : COLOR.muted;

    this.bold(11).fillColor(COLOR.accent);
    const numberText = item.shownAs + (item.shownAs !== item.authoredAs
      ? `  [Q${item.authoredAs}]` : '');
    doc.text(this.safe(numberText), PAGE.margin, top, { width: 60, continued: false });

    // "2 / 2" beside the verdict: what the question was worth, and what this
    // student got for it. Reading down the column gives the mark breakdown.
    const marksLabel = `${fmtMarks(item.awarded)} / ${fmtMarks(item.marks)}`;
    this.bold(7.6).fillColor(labelColor);
    doc.text(`${label}    ${marksLabel}`, PAGE.margin, top, {
      width: this.contentWidth, align: 'right', characterSpacing: 0.5,
    });

    doc.y = top + 14;

    // Question text.
    this.content(item.question_text, 10.5, false);
    doc.fillColor(COLOR.text).text(bodyText, PAGE.margin + 22, doc.y, { width: bodyWidth });
    doc.y += 4;

    if (image) {
      try {
        doc.image(image.buffer, PAGE.margin + 22, doc.y,
          { width: image.width, height: image.height });
        doc.y += image.height + 6;
      } catch {
        this.regular(8.5).fillColor(COLOR.muted)
          .text('[image could not be embedded]', PAGE.margin + 22, doc.y, { width: bodyWidth });
        doc.y += 4;
      }
    } else if (item.has_image) {
      this.regular(8.5).fillColor(COLOR.muted).text(
        '[this question included an image, not shown in this format]',
        PAGE.margin + 22, doc.y, { width: bodyWidth },
      );
      doc.y += 4;
    }

    // Options.
    item.options.forEach((option, index) => {
      const isChosen = item.chosen === index;
      const isKey = item.correct_option === index;
      const h = optionHeights[index];

      this.ensure(h + 4);
      const rowTop = doc.y;

      if (isChosen || isKey) {
        doc.roundedRect(PAGE.margin + 18, rowTop - 1, this.contentWidth - 18, h, 3)
          .fill(isKey ? '#e4f5ef' : '#fdeceb');
      }

      // Marker: the key is ticked, a wrong pick is crossed.
      let marker = ' ';
      let markerColor = COLOR.muted;
      if (isKey) { marker = '✓'; markerColor = COLOR.correct; }
      if (isChosen && !isKey) { marker = '✗'; markerColor = COLOR.wrong; }

      this.bold(10).fillColor(markerColor);
      doc.text(this.safe(marker), PAGE.margin + 22, rowTop + 2, { width: 12 });

      this.bold(10).fillColor(isKey ? COLOR.correct : (isChosen ? COLOR.wrong : COLOR.muted));
      doc.text(`${LETTERS[index] || index + 1}.`, PAGE.margin + 36, rowTop + 2, { width: 14 });

      this.content(option, 10, false);
      doc.fillColor(COLOR.text)
        .text(optionText[index], PAGE.margin + 52, rowTop + 2, { width: bodyWidth - 34 });

      const notes = [];
      if (isChosen) notes.push("student's answer");
      if (isKey) notes.push('correct answer');
      if (notes.length) {
        this.regular(7.6).fillColor(markerColor);
        doc.text(notes.join(' · '), PAGE.margin + 52, doc.y, { width: bodyWidth - 34 });
      }

      doc.y = rowTop + h + 1;
    });

    if (!item.answered) {
      this.regular(8.6).fillColor(COLOR.muted);
      doc.text('The student left this question blank.',
        PAGE.margin + 22, doc.y + 1, { width: bodyWidth });
    }

    doc.y += 5;
    this.rule(7);
  }

  /** Reads a question image, scaled to fit the text column. */
  loadImage(questionId) {
    const row = q.questionImage.get(questionId);
    if (!row || !row.image_data) return null;
    // pdfkit embeds PNG and JPEG only.
    if (!/^image\/(png|jpe?g)$/i.test(row.image_mime || '')) return null;

    const buffer = Buffer.from(row.image_data);
    const maxWidth = Math.min(300, this.contentWidth - 22);
    const maxHeight = 190;

    const size = this.measureImage(buffer, row.image_mime);
    if (!size) return null;
    const scale = Math.min(1, maxWidth / size.width, maxHeight / size.height);
    return {
      buffer,
      width: Math.round(size.width * scale),
      height: Math.round(size.height * scale),
    };
  }

  measureImage(buffer, mime) {
    try {
      if (/png/i.test(mime)) {
        return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
      }
      // Minimal JPEG SOF scan.
      let offset = 2;
      while (offset < buffer.length - 9) {
        if (buffer[offset] !== 0xFF) { offset += 1; continue; }
        const marker = buffer[offset + 1];
        if (marker >= 0xC0 && marker <= 0xCF
          && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
        }
        offset += 2 + buffer.readUInt16BE(offset + 2);
      }
    } catch { /* unreadable header */ }
    return null;
  }
}

/**
 * Page numbers and provenance, stamped once at the end.
 *
 * The footer sits inside the bottom margin, and pdfkit adds a fresh page for
 * anything written past the margin — which silently tripled the page count.
 * Zeroing the bottom margin for the duration keeps each footer on its own page.
 */
function stampFooters(doc, writer, label) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(range.start + i);

    const saved = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    const y = doc.page.height - PAGE.margin + 8;
    const width = doc.page.width - PAGE.margin * 2;
    writer.regular(7.8);
    doc.fillColor(COLOR.muted);
    doc.text(label, PAGE.margin, y, { width, lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, PAGE.margin, y,
      { width, align: 'right', lineBreak: false });

    doc.page.margins.bottom = saved;
  }
}

/**
 * Renders the whole document into memory and resolves with the bytes.
 *
 * Buffering rather than streaming is deliberate: a layout error halfway through
 * a piped response would leave a truncated file and a half-written HTTP reply.
 * These documents are a few hundred KB, so the trade is worth the reliability.
 */
function renderAnswerSheets(sheets) {
  return new Promise((resolve, reject) => {
    let doc;
    try {
      doc = buildDocument(sheets);
    } catch (err) {
      reject(err);
      return;
    }
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Lays the document out. Accepts one sheet or many; each student starts on a
 * fresh page. Returns the document with everything drawn but not yet ended.
 */
function buildDocument(sheets) {
  const list = Array.isArray(sheets) ? sheets : [sheets];
  if (!list.length) throw new Error('No answer sheets to render.');

  // Font is picked from the real content, so scripts survive the round trip.
  const texts = [];
  for (const sheet of list) {
    texts.push(sheet.quiz.title, sheet.student.name, sheet.student.studentId);
    if (sheet.attempt.reason) texts.push(sheet.attempt.reason);
    for (const item of sheet.questions) {
      texts.push(item.question_text);
      item.options.forEach((option) => texts.push(option));
    }
  }
  const font = chooseFont(texts);

  const doc = new PDFDocument({ ...PAGE, bufferPages: true, autoFirstPage: false });
  doc.info.Title = list.length === 1
    ? `Answer Sheet - ${list[0].student.studentId} - ${list[0].quiz.title}`
    : `Answer Sheets - ${list[0].quiz.title}`;
  doc.info.Author = 'Local WiFi Exam System';

  const writer = new SheetWriter(doc, font);

  list.forEach((sheet) => {
    doc.addPage();
    writer.syncPageWidth();
    writer.header(sheet);
    (sheet.questions || []).forEach((item) => writer.question(item));

    writer.regular(8).fillColor(COLOR.muted);
    writer.ensure(20);
    doc.text(`End of answer sheet - ${writer.safe(sheet.student.studentId)}`,
      PAGE.margin, doc.y + 2, { width: writer.contentWidth });
  });

  const label = `${list[0].quiz.title} - generated ${fmtStamp(new Date().toISOString())}`;
  stampFooters(doc, writer, writer.safe(label));

  return doc;
}

module.exports = { renderAnswerSheets, chooseFont };
