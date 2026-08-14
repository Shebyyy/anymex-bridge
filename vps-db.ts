import { Client } from 'ssh2';

const conn = new Client();
conn.on('ready', () => {
  conn.exec('sqlite3 /root/anymex-bridge/data/bridge.db "SELECT id, username FROM users;"', (err, stream) => {
    if (err) { console.log('exec err:', err.message); conn.end(); return; }
    stream.on('data', (d: Buffer) => process.stdout.write(d.toString()));
    stream.stderr.on('data', (d: Buffer) => process.stderr.write(d.toString()));
    stream.on('close', () => conn.end());
  });
}).on('error', (e: Error) => { console.log('ERR:', e.message); process.exit(1); })
  .connect({ host: 'anymex.duckdns.org', port: 22, username: 'root', password: 'Q4GXAejHqUv#zoyo' });
