'use strict';

/**
 * Recompresses question images that are already stored in the database.
 *
 * The quiz editor shrinks images as they are uploaded, but anything added
 * before that, or a PNG photo that slipped under the old ceiling, can still be
 * a megabyte. That matters more than it looks: every student downloads every
 * image at exam start, so one 1.3 MB image costs ~78 MB of Wi-Fi across a
 * 60-device room and can add a minute to the start of the exam.
 *
 *   npm run optimize-images            report only, changes nothing
 *   npm run optimize-images -- --apply write the smaller versions back
 *   npm run optimize-images -- --apply --max-kb 250
 *
 * Stop the server first if you pass --apply.
 */

const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');
const { db } = require('../src/db');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const MAX_EDGE = num('--max-edge', 1280);
const THRESHOLD = num('--max-kb', 400) * 1024;
const QUALITY = num('--quality', 82);

function num(flag, fallback) {
  const i = args.indexOf(flag);
  if (i === -1) return fallback;
  const value = Number(args[i + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;

/** Decodes PNG or JPEG into { width, height, data } RGBA. */
function decode(buffer, mime) {
  if (/png/i.test(mime)) {
    const png = PNG.sync.read(buffer);
    return { width: png.width, height: png.height, data: png.data };
  }
  if (/jpe?g/i.test(mime)) {
    const img = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true });
    return { width: img.width, height: img.height, data: img.data };
  }
  return null;
}

/**
 * Box-filter downscale. Averaging the source pixels that fall inside each
 * destination pixel avoids the aliasing that nearest-neighbour would leave on
 * diagram text.
 */
function resize(src, width, height) {
  const out = Buffer.alloc(width * height * 4);
  const xRatio = src.width / width;
  const yRatio = src.height / height;

  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.min(src.height, Math.max(y0 + 1, Math.floor((y + 1) * yRatio)));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.min(src.width, Math.max(x0 + 1, Math.floor((x + 1) * xRatio)));

      let r = 0; let g = 0; let b = 0; let a = 0; let n = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const i = (sy * src.width + sx) * 4;
          r += src.data[i]; g += src.data[i + 1]; b += src.data[i + 2]; a += src.data[i + 3];
          n += 1;
        }
      }
      const o = (y * width + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width, height, data: out };
}

/** Flattens transparency onto white — JPEG has no alpha channel. */
function flatten(img) {
  const data = Buffer.from(img.data);
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha === 255) continue;
    const k = alpha / 255;
    data[i] = Math.round(data[i] * k + 255 * (1 - k));
    data[i + 1] = Math.round(data[i + 1] * k + 255 * (1 - k));
    data[i + 2] = Math.round(data[i + 2] * k + 255 * (1 - k));
    data[i + 3] = 255;
  }
  return { width: img.width, height: img.height, data };
}

function main() {
  const rows = db.prepare(`
    SELECT question_id, quiz_id, image_mime, image_data, question_text
      FROM questions WHERE image_data IS NOT NULL`).all();

  if (!rows.length) {
    console.log('\n  No question images stored.\n');
    return;
  }

  const update = db.prepare(
    'UPDATE questions SET image_data = ?, image_mime = ? WHERE question_id = ?');

  console.log(`\n  ${rows.length} stored image(s). `
    + `Threshold ${kb(THRESHOLD)}, max edge ${MAX_EDGE}px, JPEG quality ${QUALITY}.`);
  console.log(APPLY ? '  MODE: applying changes.\n' : '  MODE: report only (pass --apply to write).\n');

  let before = 0;
  let after = 0;
  let changed = 0;

  for (const row of rows) {
    const original = Buffer.from(row.image_data);
    before += original.length;

    const label = `q${row.question_id} (quiz ${row.quiz_id}) `
      + `"${row.question_text.slice(0, 28).replace(/\s+/g, ' ')}"`;

    if (original.length <= THRESHOLD) {
      after += original.length;
      console.log(`  skip  ${label}\n        ${kb(original.length)} — already small enough`);
      continue;
    }

    let decoded;
    try {
      decoded = decode(original, row.image_mime);
    } catch (err) {
      after += original.length;
      console.log(`  FAIL  ${label}\n        could not decode (${err.message})`);
      continue;
    }
    if (!decoded) {
      after += original.length;
      console.log(`  skip  ${label}\n        ${row.image_mime} is not re-encodable here`);
      continue;
    }

    const scale = Math.min(1, MAX_EDGE / Math.max(decoded.width, decoded.height));
    const target = scale < 1
      ? resize(decoded, Math.max(1, Math.round(decoded.width * scale)),
        Math.max(1, Math.round(decoded.height * scale)))
      : decoded;

    const encoded = jpeg.encode(flatten(target), QUALITY).data;

    if (encoded.length >= original.length) {
      after += original.length;
      console.log(`  keep  ${label}\n        ${kb(original.length)} — JPEG would be `
        + `${kb(encoded.length)}, no gain`);
      continue;
    }

    after += encoded.length;
    changed += 1;
    const saved = Math.round((1 - encoded.length / original.length) * 100);
    console.log(`  ${APPLY ? 'DONE' : 'todo'}  ${label}`);
    console.log(`        ${decoded.width}x${decoded.height} ${row.image_mime} `
      + `${kb(original.length)}  ->  ${target.width}x${target.height} image/jpeg `
      + `${kb(encoded.length)}  (-${saved}%)`);

    if (APPLY) update.run(encoded, 'image/jpeg', row.question_id);
  }

  console.log(`\n  ${'-'.repeat(66)}`);
  console.log(`  total stored   ${kb(before)}  ->  ${kb(after)}`);
  if (before > after) {
    const perRoom = (before - after) * 60 / 1048576;
    console.log(`  saved          ${kb(before - after)} per student, `
      + `${perRoom.toFixed(1)} MB across a 60-device room`);
  }
  if (!APPLY && changed) {
    console.log(`\n  ${changed} image(s) would shrink. Re-run with --apply to write them:`);
    console.log('    npm run optimize-images -- --apply');
  }
  if (APPLY && changed) {
    console.log('\n  Done. Restart the server so students get the new images.');
  }
  console.log('');
}

main();
