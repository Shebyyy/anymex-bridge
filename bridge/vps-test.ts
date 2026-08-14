import { Client } from 'ssh2';

const conn = new Client();
conn.on('ready', () => {
  console.log('AUTH OK');
  const payload = JSON.stringify({ method: 'health', args: {}, id: '0' });
  console.log('Sending payload:', payload);
  
  conn.exec(payload, (err, stream) => {
    if (err) { console.log('exec ERR:', err.message); conn.end(); return; }
    let out = '', stderr = '';
    stream.on('data', (d: Buffer) => out += d.toString());
    stream.stderr.on('data', (d: Buffer) => stderr += d.toString());
    stream.on('close', () => {
      console.log('STDOUT:', out.trim());
      if (stderr) console.log('STDERR:', stderr.trim());
      conn.end();
    });
  });
}).on('error', (e: Error) => { console.log('CONN ERR:', e.message); process.exit(1); })
  .connect({ host: 'anymex.duckdns.org', port: 3022, username: 'testuser', password: 'test1234' });
