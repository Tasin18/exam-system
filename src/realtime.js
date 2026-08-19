'use strict';

const svc = require('./service');
const auth = require('./auth');
const { q } = require('./db');
// Must comfortably exceed the client heartbeat (20s) so a phone that briefly
// sleeps its radio is not shown as offline.
const HEARTBEAT_TIMEOUT_MS = 50_000;

/**
 * Wires Socket.io. Two kinds of client connect:
 *   - students, authenticated by their exam session token
 *   - staff,    authenticated by the dashboard token (administrator or teacher)
 *
 * Student sockets can never subscribe to staff events, and a teacher's socket
 * only ever receives events for exams that teacher owns. The old code put every
 * dashboard in one broadcast room, which was correct when the only dashboard
 * was the administrator's - with teachers it would have delivered every
 * school's live violation feed to everyone holding any staff account.
 */
function attachRealtime(io) {
  // Staff sockets: socketId -> { session, quizId }
  const staff = new Map();

  /** May this staff session see events for this quiz? */
  const canSee = (session, quizId) => {
    if (!session) return false;
    if (session.role === 'admin') return true;
    const row = q.getQuiz.get(Number(quizId));
    return !!row && row.owner_id === session.teacherId;
  };

  /** Emits to every staff socket entitled to see this quiz. */
  const toStaff = (quizId, event, payload) => {
    for (const [socketId, entry] of staff) {
      if (!canSee(entry.session, quizId)) continue;
      const socket = io.sockets.sockets.get(socketId);
      if (socket) socket.emit(event, payload);
    }
  };

  const pushSnapshot = (quizId) => {
    let snapshot;
    try {
      snapshot = svc.monitorSnapshot(quizId);
    } catch {
      return; // quiz was deleted
    }
    for (const [socketId, entry] of staff) {
      if (entry.quizId !== Number(quizId)) continue;
      if (!canSee(entry.session, quizId)) continue;
      const socket = io.sockets.sockets.get(socketId);
      if (socket) socket.emit('admin:snapshot', snapshot);
    }
  };

  // Coalesce bursts (a class submitting at once) into one push per quiz per tick.
  const pending = new Set();
  let flushTimer = null;
  const scheduleSnapshot = (quizId) => {
    if (quizId === undefined || quizId === null) return;
    pending.add(Number(quizId));
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const ids = [...pending];
      pending.clear();
      ids.forEach(pushSnapshot);
    }, 250);
  };

  io.on('connection', (socket) => {
    let role = null;
    let examToken = null;

    /* ---------------- Student ---------------- */

    socket.on('student:join', (payload = {}, ack) => {
      const token = payload.token;
      const attempt = svc.markOnline(token, socket.id);
      if (!attempt) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Session is not valid.' });
        socket.emit('session:invalid', { reason: 'Session is not valid or already closed.' });
        return;
      }
      role = 'student';
      examToken = token;
      socket.join(`student:${attempt.student_id}:${attempt.quiz_id}`);
      if (typeof ack === 'function') {
        ack({ ok: true, studentId: attempt.student_id, quizId: attempt.quiz_id });
      }
      scheduleSnapshot(attempt.quiz_id);
    });

    socket.on('heartbeat', () => {
      if (role === 'student') svc.touch(examToken);
      socket.emit('heartbeat:ack', { serverTime: Date.now() });
    });

    // Warning-level violation: recorded and shown to the admin, exam continues.
    socket.on('flag', (payload = {}) => {
      if (role !== 'student') return;
      const event = svc.recordFlag({ token: examToken, reason: payload.reason, severity: 'WARN' });
      if (event) scheduleSnapshot(event.quizId);
    });

    // Fatal violation: flag + terminate, per the anti-cheat spec.
    socket.on('flag_and_submit', (payload = {}, ack) => {
      if (role !== 'student') {
        if (typeof ack === 'function') ack({ ok: false, error: 'Not in an exam session.' });
        return;
      }
      try {
        const result = svc.flagAndSubmit({
          token: examToken,
          reason: payload.reason || 'Policy violation',
          answers: payload.answers,
        });
        // Student channel: no score leaves the server here either.
        const visible = svc.studentView(result);
        socket.emit('exam:terminated', { reason: payload.reason, result: visible });
        if (typeof ack === 'function') ack({ ok: true, result: visible });
        if (result) scheduleSnapshot(result.quizId);
      } catch (err) {
        if (typeof ack === 'function') ack({ ok: false, error: err.message });
      }
    });

    /* ---------------- Admin ---------------- */

    socket.on('admin:join', (payload = {}, ack) => {
      const session = auth.sessionOf(payload.token);
      if (!session) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Sign in to continue.' });
        return;
      }
      role = 'staff';
      const quizId = payload.quizId && canSee(session, payload.quizId)
        ? Number(payload.quizId) : null;
      staff.set(socket.id, { session, quizId });
      if (typeof ack === 'function') {
        ack({ ok: true, role: session.role, name: session.name });
      }
      if (quizId !== null) pushSnapshot(quizId);
    });

    socket.on('admin:watch', (payload = {}) => {
      const entry = staff.get(socket.id);
      if (!entry) return;
      const quizId = Number(payload.quizId);
      if (!Number.isInteger(quizId)) return;
      // Re-checked on every switch rather than trusted from the join: a teacher
      // could otherwise select any quiz id from the browser console and watch
      // another teacher's exam live.
      if (!canSee(entry.session, quizId)) return;
      entry.quizId = quizId;
      pushSnapshot(quizId);
    });

    socket.on('disconnect', () => {
      staff.delete(socket.id);
      if (role === 'student') {
        const entry = svc.presence.get(examToken);
        const quizId = entry ? entry.quizId : null;
        svc.markOffline(socket.id);
        scheduleSnapshot(quizId);
      }
    });
  });

  /* ---------------- Service bus -> staff dashboards ---------------- */

  svc.bus.on('flag', (event) => {
    toStaff(event.quizId, 'admin:flag', event);
    scheduleSnapshot(event.quizId);
  });

  svc.bus.on('attempt:finalized', (event) => {
    toStaff(event.quizId, 'admin:attempt', event);
    scheduleSnapshot(event.quizId);
  });

  svc.bus.on('attempt:changed', (event) => scheduleSnapshot(event.quizId));
  svc.bus.on('presence:changed', (event) => scheduleSnapshot(event.quizId));
  svc.bus.on('quiz:changed', (event) => scheduleSnapshot(event.quizId));

  // Admin reset: tell that student's client to drop its dead session.
  svc.bus.on('attempt:reset', (event) => {
    io.to(`student:${event.studentId}:${event.quizId}`).emit('session:invalid', {
      reason: 'Your attempt was reset by the administrator. Please log in again.',
    });
    toStaff(event.quizId, 'admin:reset', event);
    scheduleSnapshot(event.quizId);
  });

  /* ---------------- Timers ---------------- */

  // Server-authoritative clock: closes out attempts whose time ran out, even
  // for students whose browser or Wi-Fi died.
  const sweep = setInterval(() => {
    const closed = svc.sweepExpired();
    for (const attempt of closed) {
      if (!attempt) continue;
      io.to(`student:${attempt.studentId}:${attempt.quizId}`)
        .emit('exam:expired', { result: svc.studentView(attempt) });
      scheduleSnapshot(attempt.quizId);
    }
  }, 5_000);

  // Drop presence for sockets that stopped sending heartbeats (device slept,
  // walked out of Wi-Fi range) so the dashboard shows them offline.
  const reap = setInterval(() => {
    const cutoff = Date.now() - HEARTBEAT_TIMEOUT_MS;
    for (const [token, entry] of svc.presence) {
      if (entry.lastSeen >= cutoff) continue;
      if (io.sockets.sockets.has(entry.socketId)) continue;
      svc.presence.delete(token);
      scheduleSnapshot(entry.quizId);
    }
  }, 10_000);

  sweep.unref?.();
  reap.unref?.();

  return { pushSnapshot, stop: () => { clearInterval(sweep); clearInterval(reap); } };
}

module.exports = { attachRealtime };
