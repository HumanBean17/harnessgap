import { describe, it, expect } from 'vitest';
import { scrubCmd, scrubQuery, scrubFiles } from '../src/adapter/scrub.js';

const SENTINEL = '***REDACTED***';

describe('scrubCmd — pattern catalog', () => {
  it('1. env var: export API_KEY=... → secret gone, KEY= retained', () => {
    const out = scrubCmd('export API_KEY=sk-1234567890');
    expect(out).toContain('API_KEY=');
    expect(out).toContain(SENTINEL);
    expect(out).not.toContain('sk-1234567890');
  });

  it('2. bearer: Authorization: Bearer ... → token gone', () => {
    const out = scrubCmd("curl -H 'Authorization: Bearer abc.def.ghi'");
    expect(out).toContain(SENTINEL);
    expect(out).not.toContain('abc.def.ghi');
  });

  it('2b. case-insensitive headers: authorization: bearer ... → token gone', () => {
    // HTTP headers are case-insensitive (RFC 7230); the lowercase form must
    // also be scrubbed.
    const out = scrubCmd("curl -H 'authorization: bearer abc.def.ghi'");
    expect(out).toContain(SENTINEL);
    expect(out).not.toContain('abc.def.ghi');
  });

  it('3. url creds: https://token@host → token gone, host retained', () => {
    const out = scrubCmd('git clone https://token@github.com/o/r');
    expect(out).toContain(SENTINEL);
    expect(out).not.toContain('token@');
    expect(out).toContain('github.com');
  });

  it('4. flag secret: -p, -U, --token → value gone, flag retained', () => {
    const a = scrubCmd('psql -h host -p 5432 -U admin:secretpw');
    expect(a).toContain('-p');
    expect(a).toContain('-U');
    expect(a).toContain(SENTINEL);
    expect(a).not.toContain('5432');
    expect(a).not.toContain('secretpw');

    const ghp = 'ghp_' + 'a'.repeat(36);
    const b = scrubCmd(`tool --token ${ghp}`);
    expect(b).toContain('--token');
    expect(b).toContain(SENTINEL);
    expect(b).not.toContain(ghp);
  });

  it('5. heredoc private key: body replaced with sentinel', () => {
    const input = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEA0123456789abcdefghijklmnopqrstuvwxyz',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const out = scrubCmd(input);
    expect(out).toContain(SENTINEL);
    expect(out).not.toContain('MIIEpAIBAAKCAQEA');
    expect(out).not.toContain('BEGIN RSA PRIVATE KEY');
  });

  it('6. credential files in scrubFiles → sentinel for cred files, others unchanged', () => {
    const out = scrubFiles([
      'src/index.ts',
      '.env',
      'id_rsa',
      'deploy/service-account.json',
    ]);
    expect(out[0]).toBe('src/index.ts');
    expect(out[1]).toBe(SENTINEL);
    expect(out[2]).toBe(SENTINEL);
    expect(out[3]).toBe(SENTINEL);
  });

  it('7. known-format tokens: AWS, GitHub, Slack, JWT → each gone', () => {
    const aws = 'AKIAIOSFODNN7EXAMPLE';
    const ghp = 'ghp_' + 'a'.repeat(36);
    const slack = 'xoxb-1234567890-abcdef';
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const out = scrubCmd(`aws=${aws} gh=${ghp} slack=${slack} jwt=${jwt}`);
    expect(out).not.toContain(aws);
    expect(out).not.toContain(ghp);
    expect(out).not.toContain(slack);
    expect(out).not.toContain(jwt);
    expect(out).toContain(SENTINEL);
  });

  it('8. anti-false-positive: 40-hex SHA, UUID, 32-hex md5 → unchanged', () => {
    const sha = 'd0d3b1f2a4c5e6f7a8b9c0d1e2f3a4b5c6d7e8f9';
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const md5 = 'd41d8cd98f00b204e9800998ecf8427e';
    expect(scrubCmd(`commit ${sha}`)).toBe(`commit ${sha}`);
    expect(scrubCmd(uuid)).toBe(uuid);
    expect(scrubCmd(md5)).toBe(md5);
  });

  it('9. length cap: 600-char cmd with no secrets → truncated to 512', () => {
    const input = 'a'.repeat(600);
    const out = scrubCmd(input);
    expect(out.length).toBe(512);
    expect(out).toBe(input.slice(0, 512));
  });

  it('10. scrubFiles with 60 files → result length 50', () => {
    const files = Array.from({ length: 60 }, (_, i) => `src/file${i}.ts`);
    const out = scrubFiles(files);
    expect(out.length).toBe(50);
  });

  it('11. url creds empty-username: redis://:pass@host → pass gone, host retained', () => {
    const out = scrubCmd('redis-cli redis://:s3cr3t@host:6379');
    expect(out).toContain(SENTINEL);
    expect(out).not.toContain('s3cr3t');
    expect(out).toContain('host:6379');
  });

  it('12. url creds full: postgres://user:pass@host → pass gone, host retained', () => {
    const out = scrubCmd('psql postgres://user:pass@host:5432/db');
    expect(out).toContain(SENTINEL);
    expect(out).not.toContain('pass');
    expect(out).toContain('host:5432');
  });

  it('13. flag secret equals form: --token=val → val gone, --token= retained', () => {
    const ghp = 'ghp_' + 'a'.repeat(36);
    const out = scrubCmd('tool --token=' + ghp);
    expect(out).toContain('--token=');
    expect(out).toContain(SENTINEL);
    expect(out).not.toContain(ghp);
  });
});

describe('scrubQuery — same catalog', () => {
  it('redacts env var and respects length cap', () => {
    const out = scrubQuery('export TOKEN=sk-live-9999');
    expect(out).toContain('TOKEN=');
    expect(out).toContain(SENTINEL);
    expect(out).not.toContain('sk-live-9999');

    const long = 'q'.repeat(600);
    expect(scrubQuery(long).length).toBe(512);
  });
});
