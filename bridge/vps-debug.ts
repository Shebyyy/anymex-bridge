import { Client } from 'ssh2';

const conn = new Client();
conn.on('ready', () => {
  conn.exec('cat > /tmp/debug-ssh.js << \'EOF\'\nconst { Client } = require(\'ssh2\');\nconst fs = require(\'fs\');\n\n// Patch the bridge server to add debug logging\nconst origSshTs = fs.readFileSync(\'/root/anymex-bridge/ssh.ts\', \"utf-8\");\n\n// Replace the exec handler to add debug logging\nconst patched = origSshTs.replace(\n  `session.on(\'exec\', (accept, info) => {`,\n  `session.on(\'exec\', (accept, info) => {\n          console.log(\'[ssh:exec] info keys:\', Object.keys(info));\n          console.log(\'[ssh:exec] info.command type:\', typeof info.command);\n          console.log(\'[ssh:exec] info.command:\', JSON.stringify(info.command));\n          console.log(\'[ssh:exec] info raw:\', JSON.stringify(Object.fromEntries(Object.entries(info).map(([k,v]) => [k, typeof v === \"object\" ? \"[object]\" : v]))));`
);\n\nfs.writeFileSync(\'/root/anymex-bridge/ssh.ts\', patched);\nconsole.log(\"Patched! Restarting...");\nprocess.exit(0);\nEOF', (err, stream) => {
    if (err) { console.log('err:', err.message); conn.end(); return; }
    stream.on('close', () => conn.end());
  });
}).on('error', (e: Error) => { console.log('ERR:', e.message); process.exit(1); })
  .connect({ host: 'anymex.duckdns.org', port: 22, username: 'root', password: 'Q4GXAejHqUv#zoyo' });