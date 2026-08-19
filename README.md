# Exam System

A lightweight, high-security quiz platform. Enforces single-attempt rules and
automatic submission on focus loss or tab switching.

Two staff roles — a **teacher panel** at `/teacher` for running your own exams,
and an **administrator console** at `/admin` with full control including teacher
accounts.

It runs in either of two modes, from the same code and the same database:

- **Local Wi-Fi** (the default) - students join by typing this machine's address.
  No internet connection required at all.
- **Internet** - set `PUBLIC_URL` and students join from anywhere: mobile data,
  home broadband, another building. See **[DEPLOY.md](DEPLOY.md)**, or run
  `npm run go-live` to publish from this machine in about two minutes.

---

## Quick start

```bash
npm install          # once
npm run seed         # optional: demo quiz + 5-student roster
npm start
```

The console prints everything needed to run the exam:

```
==========================================================
  EXAM SYSTEM - running (LOCAL WIFI mode)
==========================================================
  Student portal : http://192.168.0.100:3000
  Admin console  : http://192.168.0.100:3000/admin
  Listening on   : 0.0.0.0:3000
  Database       : ...\data\exam.db
==========================================================
  Local (host)   : http://localhost:3000
  Interface      : Wi-Fi (192.168.0.100)
==========================================================
  ADMIN PASSWORD : <8 hex characters, printed here>   <-- use THIS
  (generated now and saved - it will stay the same next boot)
  Change it with: npm run password -- <new-password>
==========================================================
  Students: scan to join
      [QR code]
```

Three doors, all on the same address:

| Path | Who | What they get |
| --- | --- | --- |
| `/` | students | The exam login |
| `/teacher` | teachers | Their own quizzes, their live monitor, their results |
| `/admin` | one administrator | All of the above for every teacher, plus teacher accounts, the student roster and the join address |

> **The password is only in your own console output - this README shows a
> placeholder, not a real credential.** Scroll up in the terminal where you ran
> `npm start`, or run `npm run password` to print the saved one. To pick your
> own: `npm run password -- exam2026`, then restart.

1. Open the **admin console** and sign in with the password from your console.
2. Create a quiz under **Quizzes**, then **Activate** it.
3. Show the **Join Info** tab (URL + QR code) to the room.
4. Watch **Live Monitor** as students join, submit, and trip anti-cheat rules.
5. Export scores from **Results -> Export CSV**.

### Configuration

| Variable         | Default            | Purpose                                     |
| ---------------- | ------------------ | ------------------------------------------- |
| `PORT`           | `3000`             | Listening port                              |
| `HOST`           | `0.0.0.0`          | Bind address (all interfaces = LAN-visible) |
| `ADMIN_PASSWORD` | saved in DB        | Overrides the stored admin password         |
| `DB_FILE`        | `data/exam.db`     | SQLite file (`:memory:` for throwaway runs) |
| `PUBLIC_URL`     | unset              | Public address. **Setting it switches on internet mode** |
| `TRUST_PROXY`    | `1` when public    | Proxy hops to trust for the client's real IP |
| `FORCE_HTTPS`    | on when public+TLS | Redirect plaintext requests to https        |

Everything below `DB_FILE` applies only to an internet deployment;
[.env.example](.env.example) documents each one, and [DEPLOY.md](DEPLOY.md)
explains what each mode changes.

```bash
# Windows PowerShell
$env:ADMIN_PASSWORD="exam2026"; $env:PORT="8080"; npm start
# macOS / Linux
ADMIN_PASSWORD=exam2026 PORT=8080 npm start
```

### Scripts

| Command                 | Effect                                                    |
| ----------------------- | --------------------------------------------------------- |
| `npm start`             | Run the server (port 3000)                                |
| `npm run start:80`      | Run on port 80 so students type just the IP - **use this for phones** |
| `npm run go-live`       | Publish this machine to the internet through a Cloudflare tunnel |
| `npm run start:env`     | Run with settings loaded from a local `.env` file         |
| `npm run netcheck`      | Diagnose "students cannot open the portal" (checks the public address too) |
| `npm test`              | 159 end-to-end tests (real HTTP + WebSockets + SQLite)     |
| `npm run seed`          | Load a demo quiz, roster and a `demo` teacher account     |
| `npm run password`      | Print the saved admin password                            |
| `npm run password -- X` | Set the admin password to `X` (restart to apply)          |
| `npm run optimize-images` | Report oversized question images (add `-- --apply` to shrink) |
| `npm run reset`         | Clear **all** attempts and flags (keeps quizzes/students)  |
| `npm run reset -- 3`    | Clear attempts and flags for `quiz_id` 3 only              |

---

## Architecture

```
[ Student browsers ]  <-- local Wi-Fi (LAN) -->  [ Admin host machine ]
                                                 - Express 5 (HTTP + static)
                                                 - Socket.io 4 (realtime)
                                                 - node:sqlite (WAL mode)
```

| Layer     | Choice                                  | Why                                      |
| --------- | --------------------------------------- | ---------------------------------------- |
| Backend   | Node.js + Express 5                     | Per spec                                 |
| Realtime  | Socket.io 4                             | Heartbeat, flag alerts, live sync        |
| Database  | `node:sqlite` (built into Node >= 22.5) | Zero config, **zero native compilation** |
| Frontend  | Vanilla JS, no build step               | Lowest overhead; nothing to compile      |

Seven runtime dependencies (`express`, `socket.io`, `qrcode`, `pdfkit`,
`fontkit`, `jpeg-js`, `pngjs`) - all pure JavaScript. No native modules, no
bundler, no internet needed after `npm install`.

### Files

```
server.js                 entry point: binding, security headers, QR, static + API mount
src/origin.js             where students are told to connect: LAN address or public URL
src/ratelimit.js          per-client request limits and failed-login lockout
src/db.js                 schema, prepared statements, row mappers
src/service.js            all exam logic: login, grading, finalize, presence
src/routes.js             REST endpoints (student + admin)
src/realtime.js           Socket.io wiring, timer sweep, presence reaping
src/auth.js               roles, sessions, teacher accounts (scrypt-hashed)
src/pdf.js                answer-sheet PDF rendering + font selection
src/static.js             gzip-once asset cache, ETags, cache policy
public/index.html   + js/login.js      student login + pre-exam check
public/exam.html    + js/exam.js       exam portal
public/teacher.html                    teacher panel      (loads dashboard.js)
public/admin.html                      admin console      (+ js/admin-extras.js)
public/js/dashboard.js                 shared dashboard: monitor, editor, results
public/js/admin-extras.js              admin-only panels: teachers, student roster
public/js/lockdown.js                  anti-cheat enforcement
scripts/seed.js  scripts/reset.js      utilities
scripts/publish.js                     `npm run go-live` - tunnel + server
Dockerfile  render.yaml  fly.toml      internet deployment (see DEPLOY.md)
tests/                                 end-to-end suite
```

[src/service.js](src/service.js) is the single source of truth: a violation
arriving over a WebSocket and one arriving over HTTP run the identical code path.

---

## Roles

### The teacher panel — `/teacher`

Each teacher signs in with their own username and password, created for them by
the administrator. They can build quizzes, activate one, watch it being sat live,
grant retakes, force-submit, and export results and answer sheets.

They see **only the quizzes they created**. Another teacher's quiz is not merely
hidden from the page — the API answers `404` for it, so a teacher who opens the
browser console and calls the endpoint directly learns nothing at all. `403`
would confirm the quiz exists and let somebody walk the id space to map out what
every colleague is running and when.

Two things are deliberately withheld:

- **Teacher accounts.** Creating and disabling staff logins is the
  administrator's, or a teacher could grant themselves a second identity.
- **The join address, QR code and network panel.** These describe the server
  itself. Ask the administrator to project them.

Teachers keep the mid-exam overrides they actually need — grant retake, force
submit — scoped to their own quizzes.

### The administrator console — `/admin`

Everything a teacher can do, for every teacher's exams, plus:

| Panel | What it is for |
| --- | --- |
| Teachers | Create accounts, set passwords, disable, delete |
| Students | The whole-school roster, and the only place a student can be erased |
| Join Info | The address and QR code students use |

Disabling or deleting a teacher, or changing their password, **cuts any session
they are already holding**. Otherwise "disabled" would only mean "cannot sign in
again", leaving up to twelve hours of continued access — precisely the window in
which somebody is disabled for a reason.

Deleting a teacher **keeps their quizzes and every result**. Ownership falls to
the administrator. Losing a term of marks because a member of staff left would be
indefensible.

### Quiz ownership

`quizzes.owner_id` records who made each one. Quizzes created by the
administrator have no owner and are visible only to the administrator — which is
also what every quiz that predates this feature looks like, so an upgrade never
hands old exams to whichever teacher signs in first.

The owner is stamped from the caller's session at creation and is never read
from the request body, so a teacher cannot plant a quiz in a colleague's list.

Only **one quiz system-wide can be active at a time**, whoever owns it. A teacher
activating theirs closes whatever was running.

---

## Anti-cheat enforcement

Configured in one place - `POLICY` at the top of
[public/js/lockdown.js](public/js/lockdown.js):

| Signal                               | Event listened to            | Default action        |
| ------------------------------------ | ---------------------------- | --------------------- |
| Tab switch / minimize                | `visibilitychange`           | **Terminate**         |
| Window focus lost                    | `window.blur`                | **Terminate**         |
| Left fullscreen                      | `fullscreenchange`, `resize` | **Terminate**         |
| Pointer left the viewport            | `mouseleave`                 | Flag (exam continues) |
| Devtools / view-source shortcut      | `keydown`                    | Blocked + flagged     |
| Copy / cut / paste / select / drag   | clipboard + selection events | Blocked               |
| Right-click                          | `contextmenu`                | Blocked               |
| `Ctrl/Cmd` + `P S F R T N W A`, `F5` | `keydown`                    | Blocked               |

On termination the client locks the screen instantly, then guarantees delivery
through three paths in order: **socket ack -> HTTP POST -> `sendBeacon`**. The
attempt is recorded as `TERMINATED` with the violation reason.

### Per-student question order

Every attempt is issued a random `shuffle_seed` at login, and the exam payload is
permuted with it. Two students sitting side by side see the same questions in
different sequences, so glancing across is useless.

The seed is **stored, not regenerated**, which matters more than it sounds:
reloading the page, reconnecting after dropped Wi-Fi, or resuming a crashed
browser all rebuild the identical order. A reshuffle mid-exam would strand
already-saved answers against the wrong positions.

Grading is unaffected - answers are keyed by `question_id`, never by position.
So is the results export, and so is the invigilator's view.

Per quiz, the admin can switch it off (**Randomize question order per student**
in the editor) for exams whose questions must be read in a fixed sequence. It
defaults to **on**, including for quizzes created before this feature existed.

### Results are not shown to students

On submit a student sees only a confirmation - "Your answers have been recorded"
plus a timestamp and a note that results will be released by the examiner. No
mark, no correct-answer count, no percentage.

This is enforced **at the server boundary, not in the UI**. Hiding the score in
the page would be theatre: anyone with devtools can read the raw response. So
`studentView()` in [src/service.js](src/service.js) strips `score`, `correct`
and `total` from every student-facing channel:

- `POST /api/quiz/submit` and `POST /api/quiz/flag-submit`
- the `flag_and_submit` socket ack
- the `exam:terminated` and `exam:expired` socket events

An exam token is also rejected by every `/api/admin/*` route, so a student
cannot look their own result up. Grading still happens immediately and in full -
it simply stays server-side until you release it.

The invigilator is unaffected: live monitor, results table and CSV export all
show marks as before. [tests/score-privacy.test.js](tests/score-privacy.test.js)
walks every student response recursively and fails on any scoring field at any
depth, while asserting the admin views still carry the real numbers.

### Reviewing individual responses

Every answer a student selects is stored on the attempt (`attempts.answers_json`,
keyed by question id) and autosaved during the exam, so nothing is lost to a
crash or a termination.

**Results -> Responses** on any row opens that student's full paper: each
question, all options, which one they picked, which one was right, and a
per-question CORRECT / WRONG / NOT ANSWERED verdict. Blank answers still show
the correct option. Question images are shown inline.

Because answers are keyed by question id and never by position, a randomized
paper reviews correctly: questions are listed **in the order that student
actually saw them**, with the examiner's original numbering in brackets, so a
disputed paper matches what was on their screen.

### PDF answer sheets

| Button                       | Produces                                              |
| ---------------------------- | ----------------------------------------------------- |
| **View PDF** (in the panel)  | Opens that student's paper in a new tab, on screen     |
| **Save PDF** (in the panel)  | Downloads the same file                               |
| **All papers (PDF)**         | Downloads every student's paper, one per starting page |

Each sheet carries the student ID and name, the score and status, timestamps, the
termination reason if any, then every question with the student's answer ticked
or crossed against the correct answer. Generated server-side with `pdfkit`, so it
is a real downloadable `.pdf` with no print dialog and no internet.

Measured on a 60-student, 25-question exam with illustrated questions: one sheet
**110 ms / 257 KB**, all sixty **966 ms / 13.8 MB / 463 pages**.

**Fonts.** PDF's built-in Helvetica only covers Latin-1, which would silently
blank out Bengali, Devanagari or even `Ś` and `ā` on an official document. The
font is therefore chosen **per string** from the fonts installed on the host
(Nirmala UI, Arial, Segoe UI, DejaVu, Liberation) - so a name in Latin-Extended
and a question in Bengali can sit on the same page, each in a font that covers
it. Anything no available font can draw becomes `?` rather than a blank space.
Scripts needing complex shaping may still render imperfectly; the on-screen panel
always shows them correctly, so browser Print-to-PDF is the fallback there.

An image in a format `pdfkit` cannot embed (WebP, GIF) does not fail the
document - the sheet states that an image was present but not rendered.

**Why the dashboard fetches PDFs as blobs.** Navigating to the URL instead has
two failure modes on this setup, and both look identical to the user - clicking
does nothing:

- a `Content-Disposition: attachment` reply is *saved*, never displayed, so
  nothing appears on screen;
- Chrome and Edge block some navigation-initiated downloads from a plain-HTTP
  origin, which is exactly what a LAN exam server is.

So the dashboard fetches with an `Authorization` header, wraps the bytes in a
blob, and opens that. Blobs are same-origin and always permitted, the PDF opens
in the browser's own viewer, the admin token stays out of the URL and browser
history, and a failure surfaces as a visible message instead of silence. If a
pop-up blocker stops the new tab, it falls back to saving the file and says so.

Appending `?inline=1` to either PDF endpoint serves it with an `inline`
disposition, which makes the URL directly viewable in a browser tab - handy for
troubleshooting.

### Question images

Each question can carry one image (PNG, JPEG, GIF or WebP), added from the quiz
editor with a live preview.

- **Downscaled in the browser** before upload - longest edge 1280 px, JPEG q0.85.
  A 5 MB phone photo becomes ~150 KB, so the database stays small and exams load
  fast over Wi-Fi. Line diagrams stay PNG so text stays crisp, but a PNG over
  **400 KB** is a photo or screenshot rather than a diagram and is re-encoded as
  JPEG (only if that is actually smaller). This threshold matters: every student
  downloads every image, so one 1.3 MB PNG costs ~78 MB of Wi-Fi across a
  60-device room. The editor shows the final format and size next to each image.
- **Stored as a blob in SQLite**, not on disk, so `data/exam.db` remains the one
  file to back up. Hard limit 3 MB per image after resizing.
- **Served from `/api/quiz/image/:questionId`, never inlined** in the exam JSON.
  The payload stays a few KB regardless of how many images a quiz has, and
  browsers cache each image.
- **Access-controlled**: a student can only load images belonging to the quiz
  they are sitting; anyone else gets 401/403. Images are `pointer-events: none`
  and non-draggable, so the lockdown's right-click and save blocks still apply.
- **SVG is rejected** - it can carry script, and these files are uploaded by one
  person and rendered on every student's device.

### Deliberate deviations from the spec

Three changes were needed to make the strict policy actually work. Each is a
one-line revert if you want the literal spec.

1. **`mouseleave` flags instead of terminating.** The spec lists it under focus
   tracking, but `mouseleave` fires whenever the cursor crosses the viewport
   edge - reaching for a scrollbar or a second monitor. Auto-terminating on it
   would fail honest students. It is recorded and shown to the invigilator
   instead. Set `pointerLeave: 'submit'` in `POLICY` for the literal reading.

2. **A 1.2 s arming delay after start.** `requestFullscreen()` and the browser's
   own permission UI both shuffle focus, so listeners armed immediately would
   terminate the exam they just started. Listeners arm once the transition
   settles.

3. **No `alert()` on violation.** The spec snippet calls `alert()`, but an alert
   steals window focus and re-fires `blur`, causing a loop. A DOM overlay is
   used instead, and every terminate path is one-shot guarded.

### Honest limits of browser-based lockdown

These are OS/browser constraints, not implementation gaps:

- **`Alt+Tab` / `Cmd+Tab` cannot be intercepted.** No web page can block them.
  They are caught *after the fact* by the `blur` and `visibilitychange`
  handlers, which is what actually enforces the policy.
- **`F12` / `Ctrl+Shift+I` are not reliably preventable** in Chrome and Edge -
  browser chrome consumes them before the page. They are blocked where possible
  and flagged either way. A student who opens devtools can disable client-side
  JavaScript entirely.
- **The client is never trusted.** Because of the above, everything that matters
  is enforced server-side: grading, the time limit, and the single-attempt rule.
  The answer key is never sent to a student's browser. Disabling the lockdown
  JavaScript cannot produce a score, extra time, or a second attempt.
- For a stronger guarantee, pair this with a dedicated kiosk/lockdown browser.

---

## Server-side guarantees

| Guarantee                  | How                                                                  |
| -------------------------- | -------------------------------------------------------------------- |
| Single attempt             | `UNIQUE(student_id, quiz_id)` index - enforced in storage, not just code |
| No answer-key leakage      | `correct_option` is stripped in the student mapper; asserted by a test |
| Server-authoritative timer | Deadline computed from stored `start_time`; a 5 s sweep closes expired attempts even for disconnected clients |
| No double results          | `finalize()` UPDATE is guarded on `status='IN_PROGRESS'` - a manual submit racing an auto-submit yields one row |
| Crash-safe answers         | Autosave every 10 s plus `sendBeacon` on teardown; a `TIME_EXPIRED` attempt still grades saved answers |
| Resume without extra time  | Re-entry reissues a token against the **original** `start_time`; the old token is invalidated |
| Admin surface protected    | Every `/api/admin/*` route and the admin socket require a bearer token; student sockets can never receive admin events |
| Answer-key edit safety     | Editing questions is refused (409) while any student is mid-exam     |
| Stable shuffle             | The per-attempt seed is stored, so a reload or resume rebuilds the same order instead of stranding saved answers |
| Image access control       | `/api/quiz/image/:id` serves only images from the quiz the caller is sitting; SVG is rejected outright |
| Marks withheld             | `studentView()` strips `score`/`correct`/`total` from every student HTTP response and socket event; admin views are untouched |
| Access code never leaks    | `mapQuiz()` omits `access_code` unless a caller explicitly asks; `/api/quiz/active` reports only *whether* one is needed |
| Login cannot be brute-forced | Failed admin passwords lock the caller out; student logins are rate-limited generously enough to survive a whole class behind one NAT address |
| Password fit for a public address | Internet mode refuses to start on a generated, short or obvious `ADMIN_PASSWORD`, and never prints it |
| Teachers cannot reach each other | Every quiz, monitor, result and override route resolves through one ownership check; a non-owner gets `404`, never `403` |
| Sockets are scoped too | `admin:watch` re-checks ownership on every switch rather than trusting the join, and the live flag feed fans out per quiz instead of to one shared room |
| Revocation is immediate | Disabling, deleting or re-passwording a teacher drops their live sessions, not just their next login |
| Teacher passwords are not recoverable | Stored as scrypt hashes; the administrator can set a new one but can never read the old |

**Attempt resume is a deliberate addition.** A dropped Wi-Fi connection or a
browser crash would otherwise lock a student out permanently and force an admin
reset every time. Re-entry never resets the clock and never grants extra time.

---

## Database schema

SQLite in WAL mode. Timestamps are ISO-8601 UTC text; `options` is a JSON array.
`status` uses a `CHECK` constraint (SQLite has no `ENUM`).

- **`students`** - `student_id` (PK), `name`, `created_at`
- **`quizzes`** - `quiz_id` (PK), `title`, `duration_minutes`, `is_active`, `created_at`
  - plus: `shuffle_questions` (per-student randomization, default on)
  - plus: `access_code` (nullable; when set, students must supply it to log in)
  - plus: `owner_id` (FK to `teachers`, `ON DELETE SET NULL`; NULL = administrator's)
- **`teachers`** - `teacher_id` (PK), `username` (unique, case-insensitive),
  `display_name`, `password_hash` (scrypt), `is_active`, `created_at`, `last_login`
- **`questions`** - `question_id` (PK), `quiz_id` (FK), `question_text`, `options` (JSON), `correct_option`, `position`
  - plus: `image_data` (BLOB), `image_mime`
- **`attempts`** - `attempt_id` (PK), `student_id` (FK), `quiz_id` (FK), `status`, `score`, `start_time`, `submit_time`
  - plus: `correct_count`, `total_questions`, `answers_json`, `submission_type`, `reason`, `violations`, `token`, `shuffle_seed`
- **`flags`** - `flag_id` (PK), `student_id`, `quiz_id`, `reason`, `severity`, `created_at`
- **`settings`** - `key` (PK), `value` - host settings that must survive a restart

**Upgrades are automatic.** On boot, missing columns are added in place via
`ALTER TABLE`, so a database from an earlier version keeps every quiz, attempt
and result. Existing quizzes default to shuffled; attempts that predate the
feature have a null seed and fall back to the authored order. Re-running is a
no-op, and both behaviours are covered by [tests/migration.test.js](tests/migration.test.js).

`flags` is an addition to the spec's schema - the live violation feed and
timestamped alerts in Module A.3 need somewhere to persist. `position` keeps
question order stable, and the extra `attempts` columns back the results export.

`status` values are `IN_PROGRESS` / `SUBMITTED` / `TERMINATED`. The dashboard's
`Not Started` and `Auto-Terminated` labels are derived: no attempt row means not
started, and `TERMINATED` displays as auto-terminated.

---

## API reference

### Student

| Method | Endpoint                | Notes                                                     |
| ------ | ----------------------- | --------------------------------------------------------- |
| `GET`  | `/api/quiz/active`      | Currently open quiz, or `{active:false}`. `requiresCode` says whether an access code is needed - never the code itself |
| `POST` | `/api/auth/login`       | `{studentId, name, accessCode?}` -> session token. **403** if an attempt is recorded, or the code is wrong (`codeRequired:true`) |
| `GET`  | `/api/quiz/exam`        | Questions in this student's shuffled order, **without** the answer key |
| `GET`  | `/api/quiz/image/:questionId?t=<token>` | Question image; only for the caller's own quiz |
| `POST` | `/api/quiz/progress`    | Autosave answers                                          |
| `POST` | `/api/quiz/submit`      | `{answers, submissionType}`; graded server-side, **the mark is not returned** |
| `POST` | `/api/quiz/flag-submit` | Violation + terminate in one call                         |
| `POST` | `/api/quiz/flag`        | Record a warning-level violation                          |

A blocked login returns exactly the specified message:

```json
{ "error": "Attempt already recorded. Contact administrator for permission.",
  "status": "SUBMITTED" }
```

### Open endpoints

| Method | Endpoint         | Notes                                                        |
| ------ | ---------------- | ------------------------------------------------------------ |
| `GET`  | `/api/health`    | Liveness probe for a hosting platform. Answers over plaintext, ahead of the HTTPS redirect |
| `GET`  | `/api/network`   | The join address. Reports the LAN interface locally; withholds internal addressing once public |
| `GET`  | `/api/qr.png`    | QR code of the join address, for projecting                  |

### Staff sign-in

| Method | Endpoint              | Notes                                             |
| ------ | --------------------- | ------------------------------------------------- |
| `POST` | `/api/admin/login`    | `{password}` -> administrator token                |
| `POST` | `/api/teacher/login`  | `{username, password}` -> teacher token. One message for a wrong user, a wrong password and a disabled account |
| `GET`  | `/api/admin/session`  | Who am I: `{role, name, username, teacherId}`      |
| `POST` | `/api/admin/logout`   | Revokes this token immediately                     |

### Management - `Authorization: Bearer <staff token>`

Teachers and the administrator share these routes; the server scopes every one
of them by role. A teacher acting on a quiz they do not own gets `404`.

| Method   | Endpoint                                | Notes                                    |
| -------- | --------------------------------------- | ---------------------------------------- |
| `POST`   | `/api/admin/login`                      | `{password}` -> admin token              |
| `GET`    | `/api/admin/quizzes`                    | List with question counts                |
| `POST`   | `/api/admin/quizzes`                    | Create quiz + questions (`image` per question as a data URI, `shuffleQuestions`) |
| `GET`    | `/api/admin/quizzes/:id`                | Includes the answer key and each image inlined, so edits round-trip |
| `PUT`    | `/api/admin/quizzes/:id`                | Update; 409 if students are mid-exam     |
| `POST`   | `/api/admin/quizzes/:id/duplicate`      | Copy questions, key and images; optional `{title}`. Copy is always inactive |
| `POST`   | `/api/admin/quizzes/:id/activate`       | `{active}`; exactly one active at a time |
| `DELETE` | `/api/admin/quizzes/:id`                | Cascades to questions/attempts           |
| `GET`    | `/api/admin/monitor/:quizId`            | Full roster + statuses + flags           |
| `POST`   | `/api/admin/reset-attempt`              | `{studentId, quizId}` - grant a retake   |
| `POST`   | `/api/admin/force-submit`               | End a live attempt now                   |
| `GET`    | `/api/admin/results/:quizId`            | Scores, flags, raw answers               |
| `GET`    | `/api/admin/results/:quizId/export.csv` | Excel-safe CSV (UTF-8 BOM)               |
| `GET`    | `/api/admin/results/:quizId/student/:studentId` | One student's full paper (JSON)   |
| `GET`    | `/api/admin/results/:quizId/student/:studentId/answers.pdf` | That paper as a PDF  |
| `GET`    | `/api/admin/results/:quizId/answers.pdf` | Every student's paper in one PDF         |

### Administrator only

| Method   | Endpoint                        | Notes                                  |
| -------- | ------------------------------- | -------------------------------------- |
| `GET`    | `/api/admin/teachers`           | All teacher accounts                   |
| `POST`   | `/api/admin/teachers`           | `{username, displayName, password}`    |
| `PUT`    | `/api/admin/teachers/:id`       | `{displayName?, isActive?, password?}` - any of these cuts live sessions |
| `DELETE` | `/api/admin/teachers/:id`       | Removes the login; quizzes and results are kept |
| `DELETE` | `/api/admin/students/:studentId` | Erases a student and every attempt, school-wide |
| `GET`    | `/api/network`, `/api/qr.png`   | The join address                       |

### WebSocket events

| Direction        | Event                        | Payload / effect                          |
| ---------------- | ---------------------------- | ----------------------------------------- |
| student -> server | `student:join`              | `{token}` - registers presence            |
| student -> server | `heartbeat`                 | Liveness; ack carries server clock for drift correction |
| student -> server | `flag_and_submit`           | `{reason, answers}` - flag + terminate    |
| student -> server | `flag`                      | `{reason}` - warning only                 |
| server -> student | `exam:terminated` / `exam:expired` / `session:invalid` | Client locks the screen |
| staff -> server   | `admin:join` / `admin:watch` | `{token, quizId}` - ownership re-checked on every watch |
| server -> admin   | `admin:snapshot`            | Full roster state (coalesced, max 1 per 250 ms) |
| server -> admin   | `admin:flag` / `admin:attempt` / `admin:reset` | Live alerts            |

---

## Tests

```bash
npm test
```

159 tests against a real HTTP server, real WebSockets and a real SQLite database
- no mocks. Coverage includes: admin auth, quiz validation and CRUD, answer-key
non-leakage, autosave merging into the final score, the 403 single-attempt
block, retake reset, resume-without-extra-time, auto-termination, double-submit
idempotency, force-submit, server-side time expiry, mid-exam edit protection,
CSV export, live presence, and the guarantee that student sockets receive no
admin events.

Images and randomization add: byte-exact image round-trip, images never inlined
in the exam payload, cross-quiz image access refused, malformed/SVG/oversized
uploads rejected, editor round-trip preserving images, differing orders across
students, identical order on reload and resume, grading unaffected by shuffling,
and fixed-order mode. [tests/migration.test.js](tests/migration.test.js) builds
a database with the old schema and proves the upgrade keeps every row.

---

## Performance on phones

A room of phones sharing one 2.4 GHz radio is the real constraint, so the
delivery path is tuned for bytes and wake-ups rather than server CPU.

### Asset delivery ([src/static.js](src/static.js))

| Measured per phone            | Before   | After       |
| ----------------------------- | -------- | ----------- |
| Exam shell on the wire        | ~89 KB   | **~53 KB**  |
| CSS + JS on the wire          | 52 KB    | **15.6 KB** |
| Re-sent on a reload           | 52 KB    | **2 KB**    |
| 60 devices, text-only exam    | 12.0 MB  | **3.1 MB**  |
| Realistic start-up at 39 Mbps | ~7 s     | **~2 s**    |

Three changes got there:

- **Gzipped once at startup, held in memory.** 60 simultaneous requests cost no
  CPU and no repeated compression. CSS and JS drop by about 70%.
- **`no-store` is now scoped to `/api` only.** It previously applied to *every*
  response, so each navigation re-downloaded the whole shell. Assets carry a
  strong ETag and answer `304` with a zero-byte body.
- **HTML still revalidates every load.** The exam shell must never come from
  cache - a stale copy could skip the pre-exam attempt check - so pages are
  `no-cache` with an ETag, which costs a few hundred bytes rather than 3 KB.

Editing a file in `public/` takes effect immediately; the cache is keyed on
mtime and size, so there is nothing to rebuild or restart.

### Client smoothness

- **`content-visibility: auto` on question cards.** The whole paper is in the DOM
  so answers survive scrolling, but the browser skips layout and paint for
  off-screen questions. This is the main win when scrolling a 25-question exam.
- **No `backdrop-filter`.** Blurring a full-screen overlay forces the phone to
  re-composite everything behind it every frame. At 98.5% opacity nothing showed
  through anyway, so the blur was pure cost.
- **The timer no longer touches the DOM 120x a minute.** It ticks once a second
  and writes only when the digits actually change.
- **`touch-action: manipulation`** on options and buttons removes the ~300 ms
  double-tap-zoom wait, so answers register on the first tap.
- **Images** are `loading="lazy"` and `decoding="async"`, so a large figure never
  blocks the main thread mid-scroll.
- **Fewer radio wake-ups.** Heartbeat 8s -> 20s and Socket.io ping 10s -> 25s.
  Presence is only a dashboard display, never part of anti-cheat enforcement, so
  a slower cadence costs nothing and saves battery and latency on 60 devices.

### Images dominate everything else

One 1.3 MB image costs ~78 MB across a 60-device room and can add a minute to
the start of the exam - far more than all the code and styling combined.

New uploads are downscaled in the browser and a PNG over 400 KB is re-encoded as
JPEG. For images already in the database:

```bash
npm run optimize-images              # report only, changes nothing
npm run optimize-images -- --apply   # rewrite the oversized ones
```

It downscales to 1280 px and re-encodes to JPEG only when that is genuinely
smaller, so line diagrams are left alone. Re-running is safe - already-optimized
images are skipped. Stop the server before `--apply`, and note that it replaces
the stored image, so keep a copy of `data/exam.db` if you want the originals.

---

## Troubleshooting: students cannot open the portal

Run the built-in diagnostic first - it lists every address students can use,
whether the server answers on each, and what to check next:

```bash
npm run netcheck
```

### If it worked before and suddenly stopped: the address moved

The router hands this machine its address by DHCP, and that address can change -
after a reboot, a Wi-Fi reconnect, or simply when the lease expires. When it
does, every phone reports **"site can't be reached"** at once, even though the
server is running perfectly.

`npm run netcheck` prints the current address and says so explicitly if it has
changed since the server started. The **Join Info** tab also detects this: it
re-checks every 30 seconds, regenerates the QR code, and shows a warning naming
both the old and new address.

The permanent fix is a **DHCP reservation** (sometimes called "static lease" or
"bind IP to MAC") for this machine in the router's admin page. Without it,
anything you print, photograph or bookmark has an expiry date.

### The most common cause is the port, not the network

Typing `192.168.0.100:3000` into a phone browser usually **fails**: Chrome and
Safari treat `ip:port` as a search term, or force an HTTPS upgrade that this
server has no listener for. The address bar silently becomes a Google search.

Two ways to fix it, best first:

```bash
npm run start:80        # students then type just: 192.168.0.100
```

On port 80 the URL has no port and no scheme to get wrong - a bare IP is always
navigated as `http://`. Binding port 80 needs no administrator rights on Windows.

Otherwise students must type the `http://` prefix in full:
`http://192.168.0.100:3000`. Scanning the QR code from **Join Info** also works,
since the QR encodes the complete URL.

### Then check, in order

1. **Phone on Wi-Fi, not mobile data**, and on the same SSID as the host.
2. **AP / client isolation** on the router blocks device-to-device traffic. It is
   on by default on most guest networks. Turn it off, or run the exam off a
   phone hotspot with the host machine joined to it.
3. **Windows Firewall.** Accept the "Allow Node.js?" prompt on first run. If it
   was dismissed, add the rule from an **Administrator** terminal:
   ```
   netsh advfirewall firewall add rule name="Exam System" dir=in action=allow protocol=TCP localport=80
   ```
4. **Ignore `169.254.x.x` addresses** - those are link-local Bluetooth/virtual
   adapters and are never reachable. Students need the `192.168.x.x` or
   `10.x.x.x` one, which `npm run netcheck` identifies for you.

---

## Deployment notes

### Publishing to the internet

Full instructions are in **[DEPLOY.md](DEPLOY.md)**. In short:

```bash
npm run go-live                         # publish from this machine, temporary address
```

or set `PUBLIC_URL` and `ADMIN_PASSWORD` and deploy the included `Dockerfile`
for a permanent one. Three constraints are not negotiable: the database must sit
on a persistent volume, exactly one instance may run, and it must be served over
HTTPS.

Two things are worth knowing before you publish an exam:

- **Set an access code on the quiz** (in the admin console, beside the
  duration). On a LAN, being in the room was the gate. A public join link gets
  forwarded and screenshotted, so the code is what actually decides who sits the
  exam.
- **The lockdown does not get weaker, but the supervision does.** The browser
  controls catch exactly what they always caught. They have never been able to
  see a second device or a person in the room, and for a student sitting at
  home, neither of those is unlikely. See
  [Honest limits of browser-based lockdown](#honest-limits-of-browser-based-lockdown).

### Local Wi-Fi

- **Firewall:** on first run, Windows will prompt to allow Node.js on private
  networks. Accept it, or students cannot connect.
- **Same subnet:** guest/isolated Wi-Fi often blocks client-to-client traffic.
  If students cannot load the page, check for AP/client isolation on the router.
- **Static IP** on the host machine is recommended so the QR code stays valid.
- **Back up `data/exam.db`** after an exam - it holds all results. The WAL
  sidecars (`-shm`, `-wal`) belong with it; stop the server before copying.
- `data/` is gitignored: student results should not be committed.
