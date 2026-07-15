const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const databaseFile = path.join(root, 'db.json');
const port = 3400 + Math.floor(Math.random() * 500);
const baseUrl = `http://127.0.0.1:${port}`;
let cookie = '';

function form(values) {
  return new URLSearchParams(values).toString();
}

function rememberCookie(response) {
  const values =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
  if (values.length) cookie = values[0].split(';')[0];
}

async function request(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (cookie) headers.cookie = cookie;
  const response = await fetch(`${baseUrl}${url}`, { ...options, headers, redirect: 'manual' });
  rememberCookie(response);
  return response;
}

async function waitForServer(child) {
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return output;
    } catch {
      // The process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  throw new Error(`Test server did not start. Output: ${output}`);
}

async function run() {
  if (fs.existsSync(databaseFile)) {
    throw new Error(
      'Refusing to run smoke tests while db.json exists. Remove or back up the local development database first.'
    );
  }

  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      BASE_URL: baseUrl,
      DATABASE_URL: '',
      STRIPE_SECRET_KEY: '',
      STRIPE_WEBHOOK_SECRET: '',
      SMTP_HOST: '',
      SMTP_USER: '',
      SMTP_PASS: '',
      ADMIN_EMAIL: '',
      ADMIN_PASSWORDS: 'admin1122',
      SESSION_SECRET: 'smoke-test-session-secret',
      MARKETING_REPLY_TO: 'test@example.com'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer(child);

    let response = await request('/');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Priority List for future events/);

    response = await request('/events');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Current experience/);

    response = await request('/waitlist');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /FIRST ACCESS TO FUTURE ASILE EVENTS/);

    response = await request('/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        fullName: 'Test Person',
        phone: '+970 599 123 456',
        email: 'not-an-email',
        instagramUsername: 'testperson',
        consent: 'on'
      })
    });
    assert.equal(response.status, 400);

    const priorityEntry = {
      fullName: 'Test Person',
      phone: '+970 599 123 456',
      email: 'test.person@example.com',
      instagramUsername: '@testperson',
      consent: 'on'
    };
    response = await request('/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form(priorityEntry)
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /YOU’RE ON THE LIST/);

    response = await request('/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form(priorityEntry)
    });
    assert.equal(response.status, 200);

    response = await request('/admin/marketing');
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/admin/login');

    response = await request('/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ username: 'Smoke Test', password: 'admin1122' })
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/admin');
    assert.ok(cookie, 'Admin login did not return a session cookie.');

    for (const page of [
      '/admin',
      '/admin/waitlist',
      '/admin/customers',
      '/admin/marketing?audience=priority_access'
    ]) {
      response = await request(page);
      assert.equal(response.status, 200, `${page} should load for an authenticated admin.`);
    }

    response = await request('/admin/customers/export/marketing.csv');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /test\.person@example\.com/);

    response = await request('/admin/marketing/campaigns', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        name: 'Smoke test draft',
        subject: 'Future Asile event',
        senderName: 'Asile Events',
        replyTo: 'test@example.com',
        audience: 'priority_access',
        selectedEvent: '',
        body: 'This is a saved test draft.'
      })
    });
    assert.equal(response.status, 302);

    response = await request('/admin/marketing');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Smoke test draft/);

    response = await request('/email/unsubscribe?token=not-a-valid-token');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /LINK NOT AVAILABLE/);

    console.log(
      'Smoke test passed: public pages, Priority List, admin auth, customers, marketing, exports, and drafts.'
    );
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    if (fs.existsSync(databaseFile)) fs.unlinkSync(databaseFile);
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
