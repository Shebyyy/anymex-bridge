import { Client } from 'ssh2';

const conn = new Client();
conn.on('ready', () => {
  // Add debug logging to the SSH exec handler
  conn.exec(`sed -i "s/session.on('exec', (accept, info) => {/session.on('exec', (accept, info) => {\n          console.log('[ssh:exec] info:', JSON.stringify({command: info.command, commandType: typeof info.command, keys: Object.keys(info), requestType: info.requestType}));/" /root/anymex-bridge/ssh.ts`, (err, stream) => {
    if (err) { console.log('sed err:', err.message); conn.end(); return; }
    stream.on('data', (d: Buffer) => process.stdout.write(d.toString()));
    stream.stderr.on('data', (d: Buffer) => process.stderr.write(d.toString()));
    stream.on('close', () => {
      // Now restart the bridge server with logging
      conn.exec('kill 1980760; sleep 2; cd /root/anymex-bridge && nohup bun index.ts > data/bridge.log 2>&1 & sleep 3; echo RESTARTED', (err2, stream2) => {
        if (err2) { console.log('restart err:', err2.message); conn.end(); return; }
        stream2.on('data', (d: Buffer) => process.stdout.write(d.toString()));
        stream2.on('close', () => conn.end());
      });
    });
  });
}).on('error', (e: Error) => { console.log('ERR:', e.message); process.exit(1); })
  .connect({ host: 'anymex.duckdns.org', port: 22, username: 'root', password: 'Q4GXAejHqUv#zoyo' });