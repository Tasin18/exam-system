'use strict';

const svc = require('./service');
const adminAuth = require('./admin-auth');

const ADMIN_ROOM = 'admins';
// Must comfortably exceed the client heartbeat (20s) so a phone that briefly
// sleeps its radio is not shown as offline.
const HEARTBEAT_TIMEOUT_MS = 50_000;

/**
 * Wires Socket.io. Two kinds of client connect:
 *   - students, authenticated by their exam session token
 *   - admins,   authenticated by the dashboard token
 * Student sockets can never subscribe to admin events.
 */
function attachRealtime(io) {
  // Which quiz each admin socket is watching.
  const watching = new Map(); // socketId -> quizId

  const pushSnapshot = (quizId) => {
    let snapshot;
    try {
      snapshot = svc.monitorSnapshot(quizId);
    } catch {
      return; // quiz was deleted
    }
    for (const [socketId, watched] of watching) {
      if (watched !== quizId) continue;
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
      if (!adminAuth.verify(payload.token)) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Administrator authentication required.' });
        return;
      }
      role = 'admin';
      socket.join(ADMIN_ROOM);
      if (payload.quizId) watching.set(socket.id, Number(payload.quizId));
      if (typeof ack === 'function') ack({ ok: true });
      if (payload.quizId) pushSnapshot(Number(payload.quizId));
    });

    socket.on('admin:watch', (payload = {}) => {
      if (role !== 'admin') return;
      const quizId = Number(payload.quizId);
      if (!Number.isInteger(quizId)) return;
      watching.set(socket.id, quizId);
      pushSnapshot(quizId);
    });

    socket.on('disconnect', () => {
      watching.delete(socket.id);
      if (role === 'student') {
        const entry = svc.presence.get(examToken);
        const quizId = entry ? entry.quizId : null;
        svc.markOffline(socket.id);
        scheduleSnapshot(quizId);
      }
    });
  });

  /* ---------------- Service bus -> admin dashboards ---------------- */

  svc.bus.on('flag', (event) => {
    io.to(ADMIN_ROOM).emit('admin:flag', event);
    scheduleSnapshot(event.quizId);
  });

  svc.bus.on('attempt:finalized', (event) => {
    io.to(ADMIN_ROOM).emit('admin:attempt', event);
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
    io.to(ADMIN_ROOM).emit('admin:reset', event);
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
