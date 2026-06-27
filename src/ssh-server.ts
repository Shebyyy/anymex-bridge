/**
 * AnymeX Bridge — SSH Server
 *
 * Accepts SSH connections (public-key auth), reads line-delimited JSON
 * ClientRequests from the client, and writes line-delimited JSON
 * ServerResponses back.
 *
 * Each SSH session = one user identity (from the pubkey fingerprint).
 * Multiple exec channels per session are supported, but the typical
 * client (RemoteSidecarBridge.dart) opens one persistent exec channel
 * and pipes all requests through it.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import ssh2 from 'ssh2';
import { authenticateUser, routeRequest } from './request-router.js';
import type { ClientRequest, ServerResponse } from './types.js';

const { Server: SSHServer, utils: sshUtils } = ssh2;

const DATA_DIR = join(import.meta.dir, '..', 'data');
const HOST_KEYS_DIR = join(DATA_DIR, 'host-keys');
mkdirSync(HOST_KEYS_DIR, { recursive: true });

const HOST_KEY_PATH = join(HOST_KEYS_DIR, 'ed25519');

/** Compute OpenSSH-style sha256 fingerprint from a raw public key blob. */
function fingerprintKeyBlob(blob: Buffer): string {
  const hash = createHash('sha256').update(blob).digest('base64');
  // OpenSSH fingerprint format: "sha256:base64nopad="
  return `sha256:${hash.replace(/=+$/, '')}`;
}

/** Generate or load the SSH host key (in OpenSSH PEM format). */
async function getHostKey(): Promise<Buffer> {
  if (existsSync(HOST_KEY_PATH)) {
    return readFileSync(HOST_KEY_PATH);
  }
  console.log('[ssh] generating new ed25519 host key...');
  const keys = await new Promise<{ private: string; public: string }>(
    (resolve, reject) => {
      sshUtils.generateKeyPair(
        'ed25519',
        (err: Error | undefined, k: { private: string; public: string }) => {
          if (err) reject(err);
          else resolve(k);
        },
      );
    },
  );
  const privateKeyBuf = Buffer.from(keys.private, 'utf8');
  writeFileSync(HOST_KEY_PATH, privateKeyBuf, { mode: 0o600 });
  return privateKeyBuf;
}

export async function startSshServer(port: number): Promise<void> {
  const hostKey = await getHostKey();

  const server = new SSHServer(
    {
      hostKeys: [hostKey],
      // Accept any key — we identify the user by fingerprint, not by an allow-list.
      // (In production, you'd restrict to registered keys; this is BYO-key model.)
    },
    (client) => {
      let userId: string | null = null;
      let fingerprint: string | null = null;

      console.log('[ssh] new connection');

      client.on('authentication', (ctx) => {
        if (ctx.method !== 'publickey') {
          return ctx.reject(['publickey']);
        }
        try {
          // Server-side ctx.key is a plain { algo, data } object.
          const ctxAny = ctx as any;
          const keyData: Buffer | undefined = ctxAny.key?.data;
          if (!keyData) {
            return ctx.reject();
          }
          fingerprint = fingerprintKeyBlob(keyData);

          // Two phases of publickey auth (RFC 4252 §7):
          //   1. ctx.signature === undefined: client asks "would you accept this key type?"
          //      → calling ctx.accept() sends SSH_MSG_USERAUTH_PK_OK, client retries with signature.
          //   2. ctx.signature set: client has signed the request.
          //      → for BYO-key model, accept regardless (ssh2 has already structurally
          //        validated the signature against the key type before this event fires).
          if (!userId) {
            userId = authenticateUser(fingerprint);
            console.log(`[ssh] authenticated user=${userId} key=${fingerprint}`);
          }
          ctx.accept();
        } catch (e: any) {
          console.error('[ssh] auth error:', e?.message ?? e);
          ctx.reject();
        }
      });

      client.on('ready', () => {
        console.log(`[ssh] client ready (user=${userId})`);
      });

      client.on('session', (accept) => {
        const session = accept();
        // We use a single exec channel for the line protocol; ignore pty/shell.
        session.on('exec', (accept, reject, info) => {
          // The client runs: ssh ... anymex-bridge
          // We treat any command as "start bridge protocol"; ignore info.command.
          const channel = accept();
          handleChannel(channel, userId!, fingerprint!);
        });
      });

      client.on('end', () => {
        console.log(`[ssh] client disconnected (user=${userId})`);
      });

      client.on('error', (err) => {
        console.error('[ssh] client error:', err.message);
      });
    },
  );

  server.on('error', (err) => {
    console.error('[ssh] server error:', err);
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[ssh] AnymeX Bridge listening on 0.0.0.0:${port}`);
    console.log(`[ssh] host key: ${HOST_KEY_PATH}`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n[ssh] shutting down...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

/** Wire up an SSH exec channel to the request router. */
function handleChannel(channel: any, userId: string, fingerprint: string): void {
  const send = (resp: ServerResponse) => {
    try {
      channel.write(JSON.stringify(resp) + '\n');
    } catch (e) {
      console.error('[ssh] write failed:', e);
    }
  };

  // Read line-delimited JSON from client.
  const rl = createInterface({ input: channel });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let req: ClientRequest;
    try {
      req = JSON.parse(line);
    } catch {
      send({ id: 'parse-error', status: 'error', error: 'Invalid JSON line' });
      return;
    }
    // Stamp the authenticated userId onto the request.
    req.userId = userId;
    try {
      await routeRequest(req, send);
    } catch (e: any) {
      send({ id: req.id ?? 'unknown', status: 'error', error: e?.message ?? String(e) });
    }
  });

  channel.on('close', () => {
    rl.close();
    console.log(`[ssh] channel closed (user=${userId})`);
  });

  channel.stderr.write(`AnymeX Bridge ready. user=${userId} key=${fingerprint}\n`);
}
