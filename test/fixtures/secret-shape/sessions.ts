// Secret-shape fixture definitions: one transcript per scrubber pattern.
// Each secret is embedded in a Bash command (scrubCmd) or file path (scrubFiles)
// so the scrubber applies. The privacy test asserts:
//   (a) `***REDACTED***` is present in the normalized event's input_digest.
//   (b) The original secret string is absent from runScan --json output.
//
// Patterns covered (src/adapter/scrub.ts):
//   1. PEM private key (heredoc block)
//   2. Env-var assignment (KEY=value)
//   3. Authorization header / Bearer token
//   4. URL-embedded credentials
//   5. Flag secrets (--password, -p, etc.)
//   6. Credential-file paths (.env, *.pem, id_rsa, etc.)
//   7. Known-format tokens (AWS, GitHub, Slack, JWT)

import type { SessionSpec } from '../../helpers/builder.js';

export const secretShapeSlug = 'secret-shape';

// Each secret string is unique and recognizable so we can assert its absence.
// Token lengths MUST match the scrubber regexes exactly (e.g. AKIA + 16 chars,
// gho_ + 36 chars) — otherwise the pattern won't match and the secret survives.
export const SECRET_STRINGS: string[] = [
  'SUPERSECRETPRIVATEKEY2026', // PEM block content
  'SUPERSECRETENVVALUE42', // env-var value
  'SUPERSECRETBEARERTOKEN99', // Bearer token
  'SUPERSECRETURLPASSWORD77', // URL-embedded password
  'SUPERSECRETPASSWORD123', // --password flag value
  // Credential-file paths are tested via the sentinel in input_digest.files.
  'AKIASUPERSECRETAWSXY', // AWS access key ID (AKIA + 16 uppercase)
  'gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', // GitHub token (gho_ + 36 alphanumeric)
];

export const secretShapeSessions: SessionSpec[] = [
  // 1. PEM private key in a heredoc command.
  {
    name: 'pem-key',
    events: [
      {
        kind: 'exec',
        cmd: `cat <<'EOF'\n-----BEGIN RSA PRIVATE KEY-----\nSUPERSECRETPRIVATEKEY2026\n-----END RSA PRIVATE KEY-----\nEOF`,
        ok: true,
      },
      { kind: 'edit', file: 'src/app/a.ts', newString: 'y' },
    ],
  },

  // 2. Env-var assignment in a command.
  {
    name: 'env-var',
    events: [
      { kind: 'exec', cmd: 'export API_KEY=SUPERSECRETENVVALUE42', ok: true },
      { kind: 'edit', file: 'src/app/b.ts', newString: 'y' },
    ],
  },

  // 3. Authorization header / Bearer token.
  {
    name: 'auth-header',
    events: [
      {
        kind: 'exec',
        cmd: 'curl -H "Authorization: Bearer SUPERSECRETBEARERTOKEN99" https://example.com',
        ok: true,
      },
      { kind: 'edit', file: 'src/app/c.ts', newString: 'y' },
    ],
  },

  // 4. URL-embedded credentials.
  {
    name: 'url-creds',
    events: [
      {
        kind: 'exec',
        cmd: 'redis://user:SUPERSECRETURLPASSWORD77@redis.example.com:6379',
        ok: true,
      },
      { kind: 'edit', file: 'src/app/d.ts', newString: 'y' },
    ],
  },

  // 5. Flag secrets (--password).
  {
    name: 'flag-secret',
    events: [
      {
        kind: 'exec',
        cmd: 'curl --password SUPERSECRETPASSWORD123 https://example.com',
        ok: true,
      },
      { kind: 'edit', file: 'src/app/e.ts', newString: 'y' },
    ],
  },

  // 6. Credential-file paths (Read of .env, id_rsa, credentials.json).
  {
    name: 'cred-file',
    events: [
      { kind: 'read', file: 'src/secrets/.env' },
      { kind: 'read', file: 'src/secrets/id_rsa' },
      { kind: 'read', file: 'src/secrets/credentials.json' },
      { kind: 'edit', file: 'src/app/f.ts', newString: 'y' },
    ],
  },

  // 7. Known-format tokens (AWS, GitHub, Slack, JWT) in a command.
  {
    name: 'known-tokens',
    events: [
      {
        kind: 'exec',
        cmd: 'aws configure set aws_access_key_id AKIASUPERSECRETAWSXY && echo gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
        ok: true,
      },
      { kind: 'edit', file: 'src/app/g.ts', newString: 'y' },
    ],
  },
];
