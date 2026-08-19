# Putting the exam on the internet

By default this system serves one room: students type the host machine's Wi-Fi
address and have to be on the same network. This guide covers the other mode,
where students join from anywhere — mobile data, home broadband, a different
campus — with nothing installed on their devices.

Nothing about the exam logic changes. The single-attempt rule, the
server-authoritative clock and the anti-cheat lockdown behave identically. What
changes is who can reach the login page, and therefore what has to guard it.

---

## The one switch

```
PUBLIC_URL=https://exam.yourschool.edu
```

Setting `PUBLIC_URL` tells the server it is publicly reachable. That single
variable turns on:

| | Local Wi-Fi (unset) | Internet (set) |
|---|---|---|
| Join address students see | this machine's IPv4 address | your public URL |
| QR code encodes | `http://192.168.x.x:3000` | your public URL |
| Admin password | auto-generated, printed at boot | **required** from `ADMIN_PASSWORD`, never printed |
| HTTP → HTTPS redirect | off | on (when `PUBLIC_URL` is `https`) |
| HSTS | off | on, over TLS |
| Client IP for rate limits | the socket peer | the real client, read through one proxy hop |
| Join Info panel | shows the network interface | withholds internal addressing |
| `npm run seed` demo teacher | created (`demo` / `demo-password`) | skipped — create real accounts |

The server **refuses to start** in internet mode without a strong
`ADMIN_PASSWORD`. That is deliberate: on a LAN the generated eight-character
password was protected by the walls of the room, and on the internet it is not
protected by anything.

---

## Option A — publish from this machine (about two minutes)

Best for a one-off sitting where the laptop you already have is the host. A
Cloudflare tunnel dials **out** to Cloudflare and gets a public HTTPS address
back, so nothing has to be opened on the router or the firewall, and no fixed IP
address is needed. The exam and its database never leave your machine; only the
traffic is relayed.

1. Install `cloudflared` once:

   ```
   winget install --id Cloudflare.cloudflared     # Windows
   brew install cloudflared                       # macOS
   ```

2. Run:

   ```
   npm run go-live
   ```

It prints the public address, generates a strong admin password, shows it, and
starts the server already configured for that address.

**Know the trade-off.** The hostname is randomly assigned, changes every time
you run the command, and the tunnel dies when you close the terminal or the
laptop sleeps. That is fine for a single sitting you are watching, and wrong for
a system a department depends on every week — for that, use Option B.

---

## Option B — deploy to a host (a permanent address)

The repository ships with a `Dockerfile`, a `render.yaml` and a `fly.toml`.
Whichever you use, three things must be true:

1. **`DB_FILE` points at a persistent volume.** The whole system — every quiz,
   attempt, answer and result — is one SQLite file. On a host with an ephemeral
   filesystem, the default location is erased on every deploy and restart.
2. **Exactly one instance.** Presence tracking, admin session tokens and the
   exam clock live in the process; the database is a single file. A second
   instance is a second, diverging copy of the exam.
3. **HTTPS.** Exam tokens, the admin password and every submitted answer travel
   in these requests.

### Render

```
# render.yaml is already in the repo. Push to GitHub, then New > Blueprint.
```

After the first deploy, set `PUBLIC_URL` to the real service URL (Render shows
it once the service exists) and read the generated `ADMIN_PASSWORD` from the
service's Environment tab. Note that a persistent disk requires a paid plan;
Render's free tier has no disk and would lose every result.

### Fly.io

```
fly launch --no-deploy
fly secrets set PUBLIC_URL=https://your-app.fly.dev
fly secrets set ADMIN_PASSWORD=$(node -p "crypto.randomUUID()")
fly deploy
```

### Any Docker host

```
docker build -t exam-system .
docker run -d --name exam \
  -p 3000:3000 \
  -v exam-data:/data \
  -e PUBLIC_URL=https://exam.yourschool.edu \
  -e ADMIN_PASSWORD='...' \
  exam-system
```

### Your own server, behind nginx

Run the app on localhost and let nginx terminate TLS:

```nginx
server {
  listen 443 ssl;
  server_name exam.yourschool.edu;

  # Certificates from certbot, or wherever you get them.
  ssl_certificate     /etc/letsencrypt/live/exam.yourschool.edu/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/exam.yourschool.edu/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;

    # Required: the live dashboard and every student's heartbeat run over a
    # WebSocket. Without these two lines the exam still works, but the
    # invigilator's monitor stays empty and students see "Reconnecting..."
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    # Required: this is how the app learns the real client address and that the
    # request arrived over TLS.
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

    # A student may sit at a question for a long time without the socket saying
    # anything the proxy considers activity.
    proxy_read_timeout 3600s;
  }
}
```

Start the app with `HOST=127.0.0.1` so nothing but nginx can reach it directly.

---

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `PUBLIC_URL` | unset | The address students use. Setting it enables internet mode. |
| `ADMIN_PASSWORD` | generated | Admin console password. Required, min 12 chars, in internet mode. |
| `DB_FILE` | `./data/exam.db` | SQLite database. Put it on a persistent volume. |
| `PORT` | `3000` | Listen port. Most platforms inject this. |
| `HOST` | `0.0.0.0` | Bind address. Use `127.0.0.1` behind a local reverse proxy. |
| `TRUST_PROXY` | `1` in internet mode | Proxy hops to trust for the client's real IP. |
| `FORCE_HTTPS` | on for `https://` `PUBLIC_URL` | Redirect plaintext requests. Set `0` if it loops. |

`.env.example` documents all of these. To load a `.env` file:

```
npm run start:env
```

---

## Before you run a real exam

- [ ] **Create teacher accounts** in the admin console rather than handing the
      administrator password around. A teacher only ever sees their own exams,
      and disabling one account does not disturb anybody else's sitting.
- [ ] **Set an access code on the quiz.** In the admin console, next to the
      duration. A public join link gets forwarded, screenshotted and pasted into
      group chats — the code is what actually decides who sits the exam. Read it
      out at the start; don't put it in the same message as the link.
- [ ] **Check the address from outside your network.** Turn Wi-Fi off on a phone
      and open the URL over mobile data. `PUBLIC_URL=... npm run netcheck` does
      the same check from the command line.
- [ ] **Confirm it is HTTPS.** The Join Info panel says so plainly, and warns
      when it is not.
- [ ] **Do a full dry run** with one student account: log in, answer, submit.
      Confirm the attempt lands in the admin monitor in real time — if it does
      not, the WebSocket is not getting through your proxy.
- [ ] **Take a backup** of the database file before the exam, and export results
      to CSV or PDF afterwards rather than relying on the volume.

---

## What the internet changes about proctoring

Worth saying plainly, because it is easy to deploy this and assume nothing has
changed: the lockdown enforces what the *browser* can observe. It catches tab
switches, focus loss and leaving fullscreen, and it does that as well on the
internet as on a LAN. It has never been able to see a second device, a person in
the room, or a phone beside the keyboard — and when students sit at home, those
are no longer unlikely.

The technical controls carry over intact. The supervision does not. Treat a
remotely-sat paper accordingly: shorter time limits, randomised question order
(on by default), question banks larger than any one sitting, and marks that
assume the exam is open-book unless something outside this system is watching
the room.

---

## Troubleshooting

**Students see a redirect loop.** TLS is terminating somewhere that does not
send `X-Forwarded-Proto`, so the app thinks every request is plaintext. Set
`FORCE_HTTPS=0`, or fix the proxy header — the header is the better fix.

**The admin monitor is empty and students see "Reconnecting…".** The WebSocket
upgrade is not getting through. Add the `Upgrade`/`Connection` headers shown
above. The exam itself still works: submissions go over ordinary HTTP.

**Everything works, but the QR code shows the wrong address.** `PUBLIC_URL` is
not set in the environment the *server* was started with — check with
`PUBLIC_URL=<url> npm run netcheck`, which reports the mismatch explicitly.

**"REFUSING TO START — the admin console would be exposed".** Internet mode with
no `ADMIN_PASSWORD`, or a short or obvious one. Set a long one and restart.

**Results disappeared after a deploy.** `DB_FILE` was not on a persistent
volume. There is nothing to recover; set it before the next exam.
