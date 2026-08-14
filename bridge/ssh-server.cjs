/**
 * SSH Server — runs under Node.js because Bun's ssh2 compatibility has issues.
 * Proxies SSH exec commands to the Bun HTTP server on localhost:8082.
 */
const { Server } = require('ssh2');
const http = require('http');
const fs = require('fs');
const path = require('path');

const SSH_PORT = parseInt(process.env.SSH_PORT || '3022', 10);
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '8082', 10);
const HOST_KEY_PATH = path.join(__dirname, 'data', 'host_key');

function getHostKey() {
  try { return fs.readFileSync(HOST_KEY_PATH); } catch {}
  const { generateKeyPairSync } = require('crypto');
  const key = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });
  fs.writeFileSync(HOST_KEY_PATH, key.privateKey);
  console.log('[ssh] Generated new RSA 2048 host key');
  return key.privateKey;
}

function httpPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port: HTTP_PORT, path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let chunk = '';
      res.on('data', d => chunk += d);
      res.on('end', () => {
        try { resolve(JSON.parse(chunk)); } catch { resolve({ ok: false, error: 'invalid json from http' }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const sshServer = new Server({
  hostKeys: [getHostKey()],
  algorithms: { kex: ['ecdh-sha2-nistp256'], serverHostKey: ['rsa-sha2-256', 'ssh-rsa'] }
});

sshServer.on('connection', (client) => {
  let username = null;
  let password = null;

  client.on('authentication', (ctx) => {
    if (ctx.method === 'password') {
      httpPost('/login', { username: ctx.username, password: ctx.password })
        .then(result => {
          if (result.ok) {
            username = result.user.username;
            password = ctx.password;
            console.log(`[ssh] User '${username}' authenticated`);
            ctx.accept();
          } else {
            ctx.reject();
          }
        })
        .catch(() => ctx.reject());
    } else {
      ctx.reject();
    }
  });

  client.on('ready', () => {
    console.log(`[ssh] User '${username}' connected`);

    client.on('session', (accept) => {
      const session = accept();

      // ssh2 v1.17.0 changed exec event: (accept, reject, info)
      // Older versions used: (accept, info)
      session.on('exec', (acceptExec, rejectExec, info) => {
        const channel = acceptExec();

        // Handle both old (2-arg) and new (3-arg) API
        const execInfo = info || rejectExec;
        const raw = (execInfo && execInfo.command ? execInfo.command : '').trim();

        if (!raw) {
          channel.write(JSON.stringify({ id: '0', status: 'error', error: 'empty command' }) + '\n');
          channel.close();
          return;
        }

        try {
          const msg = JSON.parse(raw);
          console.log(`[ssh] ${username} -> ${msg.method}`);

          httpPost('/rpc', {
            username, password,
            method: msg.method,
            args: msg.args || {},
            id: msg.id || '0'
          }).then(result => {
            channel.write(JSON.stringify(result) + '\n');
            channel.close();
          }).catch(err => {
            channel.write(JSON.stringify({ id: msg.id || '0', status: 'error', error: err.message }) + '\n');
            channel.close();
          });
        } catch {
          channel.write(JSON.stringify({ id: '0', status: 'error', error: 'invalid JSON' }) + '\n');
          channel.close();
        }
      });
    });
  });

  client.on('close', () => console.log(`[ssh] User '${username}' disconnected`));
});

sshServer.listen(SSH_PORT, '0.0.0.0', () => console.log(`[ssh-node] Listening on port ${SSH_PORT}`));
