import { describe, it, expect } from 'vitest';
import { classifyCmd, classifyFile } from '../src/diagnoser/classify-util.js';
import { DEFAULT_CONFIG } from '../src/config.js';

// Verbatim from `cfg.areas.test_cmd_patterns` (src/config.ts). Imported here so
// the "defaults" cases stay grounded to the real configuration the detector
// uses, rather than a hand-maintained duplicate.
const DEFAULTS = DEFAULT_CONFIG.areas.test_cmd_patterns;

describe('classifyCmd — precedence test > config > build > other', () => {
  it('npm test (default patterns) → test', () => {
    expect(classifyCmd('npm test', DEFAULTS)).toBe('test');
  });

  it('npm install → config', () => {
    expect(classifyCmd('npm install', DEFAULTS)).toBe('config');
  });

  it('npm run build → build', () => {
    expect(classifyCmd('npm run build', DEFAULTS)).toBe('build');
  });

  it('grep foo → other', () => {
    expect(classifyCmd('grep foo', DEFAULTS)).toBe('other');
  });

  it('empty string → other', () => {
    expect(classifyCmd('', DEFAULTS)).toBe('other');
  });

  it('whitespace-only → other', () => {
    expect(classifyCmd('   \t  ', DEFAULTS)).toBe('other');
  });

  it('precedence: test wins over build when a build token is a test pattern', () => {
    // "npm run build" matches the build catalog; but with "build" added to the
    // test-cmd patterns the test class must win (test > build).
    expect(classifyCmd('npm run build', [...DEFAULTS, 'build'])).toBe('test');
  });

  it('precedence: config wins over build (docker compose install-shaped cmd)', () => {
    // "setup install" — both `setup` (config) and the absence of build tokens;
    // confirms config rank sits above build.
    expect(classifyCmd('npm setup install', DEFAULTS)).toBe('config');
  });

  it('config catalog: prisma migrate dev → config', () => {
    expect(classifyCmd('prisma migrate dev', DEFAULTS)).toBe('config');
  });

  it('build catalog: tsc --noEmit → build', () => {
    expect(classifyCmd('tsc --noEmit', DEFAULTS)).toBe('build');
  });
});

describe('classifyFile — precedence test > other > code', () => {
  it('src/billing/charge.test.ts → test', () => {
    expect(classifyFile('src/billing/charge.test.ts')).toBe('test');
  });

  it('src/billing/charge.ts → code', () => {
    expect(classifyFile('src/billing/charge.ts')).toBe('code');
  });

  it('package.json → other', () => {
    expect(classifyFile('package.json')).toBe('other');
  });

  it('config/app.yml → other', () => {
    expect(classifyFile('config/app.yml')).toBe('other');
  });

  it('README.md → other', () => {
    expect(classifyFile('README.md')).toBe('other');
  });

  it('precedence: foo.test.json → test (test wins over other)', () => {
    // `.json` is in the `other` extension catalog, but `.test.` wins because
    // test > other.
    expect(classifyFile('foo.test.json')).toBe('test');
  });

  it('test segment: tests/foo.ts → test', () => {
    expect(classifyFile('tests/foo.ts')).toBe('test');
  });

  it('__tests__ segment: src/__tests__/a.ts → test', () => {
    expect(classifyFile('src/__tests__/a.ts')).toBe('test');
  });

  it('Dockerfile basename → other', () => {
    expect(classifyFile('Dockerfile')).toBe('other');
  });

  it('.env basename → other', () => {
    expect(classifyFile('.env')).toBe('other');
  });

  it('lockfile (.lock) → other', () => {
    expect(classifyFile('pnpm-lock.yaml.lock')).toBe('other');
  });
});
