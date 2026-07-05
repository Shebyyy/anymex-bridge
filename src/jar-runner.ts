/**
 * AnymeX Bridge — JAR Runner
 *
 * Manages the single shared JAR subprocess that all users share.
 * Communication protocol matches the local SidecarBridge.dart contract:
 *
 *   iOS → server → JAR stdin (line-delimited JSON):
 *     { method, args, id }
 *
 *   JAR stdout → server → iOS (line-delimited JSON):
 *     { id, status, data }
 *
 * The server proxies bytes through transparently for invoke/invokeStream,
 * but adds a userId envelope when receiving from iOS so it can enforce
 * install-gating before forwarding to the JAR.
 *
 * Lifecycle:
 *   - lazily started on first invoke request
 *   - automatically restarted if it crashes
 *   - hot-swapped by the auto-updater when a new JAR is downloaded
 */

import { spawn, execSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ServerResponse } from './types.js';

const DATA_DIR = join(import.meta.dir, '..', 'data');
const JAR_PATH = join(DATA_DIR, 'bridge.jar');
const JAR_NEW_PATH = join(DATA_DIR, 'bridge.jar.new');

mkdirSync(DATA_DIR, { recursive: true });

class JarRunner {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private readyPromise: Promise<void> | null = null;
  private startLock = false;

  /** Listeners for outgoing JSON lines from the JAR. */
  private lineListeners = new Set<(line: string) => void>();

  /** Listeners for stderr log lines (used for "started" signal too). */
  private stderrListeners = new Set<(line: string) => void>();

  constructor() {
    // Kill any leftover JAR processes from a previous run (orphan protection).
    this.killOrphanJars();
  }

  /** Kill any bridge.jar processes that aren't our child. */
  private killOrphanJars(): void {
    try {
      const out = execSync('pgrep -f "bridge.jar"', { encoding: 'utf8' }).trim();
      if (!out) return;
      for (const pidStr of out.split('\n')) {
        const pid = parseInt(pidStr, 10);
        if (isNaN(pid) || pid === process.pid) continue;
        // Don't kill our own child
        if (this.proc && pid === this.proc.pid) continue;
        try {
          process.kill(pid, 'SIGKILL');
          console.log(`[jar-runner] killed orphan JAR process: pid=${pid}`);
        } catch {}
      }
    } catch {
      // pgrep returns non-zero when no matches — that's fine.
    }
  }

  /** True if the JAR file is present on disk. */
  isJarPresent(): boolean {
    return existsSync(JAR_PATH);
  }

  /** Get the current JAR path. */
  getJarPath(): string {
    return JAR_PATH;
  }

  /** Hot-swap: rename bridge.jar.new → bridge.jar, then restart. */
  async hotSwap(): Promise<void> {
    if (existsSync(JAR_NEW_PATH)) {
      console.log('[jar-runner] hot-swapping bridge.jar.new → bridge.jar');
      renameSync(JAR_NEW_PATH, JAR_PATH);
    }
    await this.restart();
  }

  /** Subscribe to JAR stdout JSON lines. Returns an unsubscribe fn. */
  onLine(fn: (line: string) => void): () => void {
    this.lineListeners.add(fn);
    return () => this.lineListeners.delete(fn);
  }

  /** Subscribe to JAR stderr lines. Returns an unsubscribe fn. */
  onStderr(fn: (line: string) => void): () => void {
    this.stderrListeners.add(fn);
    return () => this.stderrListeners.delete(fn);
  }

  /** Ensure the JAR is running & ready. Returns when "started" signal observed. */
  async ensureReady(): Promise<void> {
    if (this.ready && this.proc) return;
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.start();
    try {
      await this.readyPromise;
    } finally {
      this.readyPromise = null;
    }
  }

  /** Send a JSON request line to the JAR's stdin. */
  async send(request: object): Promise<void> {
    await this.ensureReady();
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error('JAR process not writable');
    }
    this.proc.stdin.write(JSON.stringify(request) + '\n');
  }

  /** Restart the JAR (kills existing if any). */
  async restart(): Promise<void> {
    if (this.startLock) return;
    this.startLock = true;
    try {
      await this.killAndWait();
      this.ready = false;
      this.readyPromise = null;
      await this.start();
    } finally {
      this.startLock = false;
    }
  }

  /** Kill the current JAR process and wait for it to actually exit. */
  private async killAndWait(): Promise<void> {
    const oldProc = this.proc;
    this.proc = null;
    if (!oldProc) return;

    const exitPromise = new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        // Force kill if SIGTERM didn't work within 5s
        try { oldProc.kill('SIGKILL'); } catch {}
        resolve();
      }, 5000);
      oldProc.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    try {
      oldProc.kill('SIGTERM');
    } catch {}

    await exitPromise;
    console.log('[jar-runner] old JAR process exited');
  }

  private async start(): Promise<void> {
    if (!this.isJarPresent()) {
      throw new Error(
        `JAR not found at ${JAR_PATH}. The auto-updater should fetch it on first start. ` +
          `You can also drop it there manually.`,
      );
    }

    // Find java on PATH.
    const javaBin = process.env.JAVA_BIN ?? 'java';

    // JVM heap cap — defaults to 384m so we're safe on small/shared VPS boxes
    // (e.g. a 1.9 GB server already running Supabase + Next.js + nginx).
    // Override with ANYMEX_JVM_HEAP=512m (or 1g, etc.) on bigger/dedicated hosts.
    const jvmHeap = process.env.ANYMEX_JVM_HEAP ?? '384m';
    const javaArgs = [`-Xmx${jvmHeap}`, '-jar', JAR_PATH];
    console.log(`[jar-runner] spawning: ${javaBin} ${javaArgs.join(' ')}`);

    this.proc = spawn(javaBin, javaArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Hint to the JAR that it's running in remote-bridge mode.
        ANYMEX_BRIDGE_MODE: 'remote',
      },
    });

    const stdout = this.proc.stdout;
    const stderr = this.proc.stderr;
    if (!stdout || !stderr) {
      throw new Error('Failed to capture JAR stdio');
    }

    const stdoutRl = createInterface({ input: stdout });
    const stderrRl = createInterface({ input: stderr });

    const readySignal = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        // Same behaviour as SidecarBridge.dart: continue anyway after 10s.
        console.warn('[jar-runner] startup signal not received within 10s, continuing anyway');
        resolve();
      }, 10_000);
      const onStderrLine = (line: string) => {
        console.log(`[jar-stderr] ${line}`);
        if (line.includes('AnymeX Sidecar Process Started')) {
          clearTimeout(timeout);
          stderrRl.removeListener('line', onStderrLine);
          resolve();
        }
      };
      stderrRl.on('line', onStderrLine);
      this.proc!.once('exit', (code) => {
        clearTimeout(timeout);
        if (!this.ready) reject(new Error(`JAR exited before becoming ready (code=${code})`));
      });
    });

    stdoutRl.on('line', (line) => {
      if (!line) return;
      for (const fn of this.lineListeners) {
        try { fn(line); } catch (e) { console.error('[jar-runner] line listener threw', e); }
      }
    });
    stderrRl.on('line', (line) => {
      for (const fn of this.stderrListeners) {
        try { fn(line); } catch {}
      }
    });

    this.proc.once('exit', (code, signal) => {
      console.warn(`[jar-runner] JAR exited code=${code} signal=${signal}`);
      this.ready = false;
      this.proc = null;
      // Notify all listeners that the JAR is gone (they should error out in-flight requests).
      const errResp: ServerResponse = {
        id: '__jar_died__',
        status: 'error',
        error: `JAR process exited (code=${code} signal=${signal})`,
      };
      for (const fn of this.lineListeners) {
        try { fn(JSON.stringify(errResp)); } catch {}
      }
    });

    this.proc.once('error', (err) => {
      console.error('[jar-runner] spawn error:', err);
      this.ready = false;
      this.proc = null;
    });

    await readySignal;
    this.ready = true;
    console.log('[jar-runner] JAR is ready');
  }

  dispose(): void {
    const oldProc = this.proc;
    this.proc = null;
    if (oldProc) {
      try { oldProc.kill('SIGKILL'); } catch {}
    }
    this.lineListeners.clear();
    this.stderrListeners.clear();
  }
}

export const jarRunner = new JarRunner();
export { JAR_PATH, JAR_NEW_PATH };
