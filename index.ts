/**
 * AnymeX Bridge — Entry Point
 *
 * Starts:
 *   1. SSH server (line-delimited JSON protocol on port 3022)
 *   2. JAR auto-updater (polls GitHub Releases every 1h)
 *
 * The JAR itself is started lazily on first invoke request.
 */

import { startSshServer } from './src/ssh-server.js';
import { startUpdater } from './src/auto-updater.js';
import { jarRunner } from './src/jar-runner.js';

const PORT = 3022;

console.log('============================================================');
console.log('  AnymeX Extension Runtime Bridge — Remote Server');
console.log('============================================================');
console.log(`  Port:       ${PORT}`);
console.log(`  JAR path:   ${jarRunner.getJarPath()}`);
console.log(`  JAR present: ${jarRunner.isJarPresent()}`);
console.log('============================================================\n');

// 1. Start the SSH server immediately.
startSshServer(PORT).catch((e) => {
  console.error('[main] SSH server failed to start:', e);
  process.exit(1);
});

// 2. Start the auto-updater (will download the JAR if missing).
startUpdater();

// 3. Health-check log every 5 min.
setInterval(() => {
  console.log(
    `[health] JAR ready=${jarRunner['ready'] ?? false} present=${jarRunner.isJarPresent()}`,
  );
}, 5 * 60 * 1000).unref();
