import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CONFIG,
  loadConfig,
  parseDuration,
  ConfigError,
} from '../src/config.js';

const tmpDirs: string[] = [];

/** Write a YAML string to a temp .harnessgap.yml and return its path. */
function writeTmpConfig(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'harnessgap-cfg-'));
  tmpDirs.push(dir);
  const path = join(dir, '.harnessgap.yml');
  writeFileSync(path, yaml, 'utf8');
  return path;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('config loader', () => {
  it('DEFAULT_CONFIG has flag_pct === 90 and areas.touch_weights.edit === 3', () => {
    expect(DEFAULT_CONFIG.detector.flag_pct).toBe(90);
    expect(DEFAULT_CONFIG.areas.touch_weights.edit).toBe(3);
  });

  it('loadConfig() with no file present returns DEFAULT_CONFIG (deep-equal)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harnessgap-empty-'));
    const originalCwd = process.cwd();
    try {
      process.chdir(dir);
      expect(loadConfig()).toEqual(DEFAULT_CONFIG);
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loadConfig() returns a copy, not the shared DEFAULT_CONFIG reference', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harnessgap-ref-'));
    const originalCwd = process.cwd();
    try {
      process.chdir(dir);
      expect(loadConfig()).not.toBe(DEFAULT_CONFIG);
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loadConfig(path) deep-merges detector.flag_pct: 75, keeping all other defaults', () => {
    const path = writeTmpConfig('detector:\n  flag_pct: 75\n');
    const cfg = loadConfig(path);
    expect(cfg.detector.flag_pct).toBe(75);
    const expected: typeof DEFAULT_CONFIG = {
      ...DEFAULT_CONFIG,
      detector: { ...DEFAULT_CONFIG.detector, flag_pct: 75 },
    };
    expect(cfg).toEqual(expected);
  });

  it('loadConfig(path) array override areas.ignore: [foo] replaces (not concats)', () => {
    const path = writeTmpConfig('areas:\n  ignore: [foo]\n');
    const cfg = loadConfig(path);
    expect(cfg.areas.ignore).toEqual(['foo']);
  });

  it('loadConfig(path) with flag_pct: 150 throws ConfigError', () => {
    const path = writeTmpConfig('detector:\n  flag_pct: 150\n');
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  it('loadConfig(path) with unknown key bogus: 1 throws ConfigError', () => {
    const path = writeTmpConfig('bogus: 1\n');
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  it('parseDuration converts d/h/m/s to ms; undefined/empty -> Infinity; bad throws', () => {
    expect(parseDuration('30d')).toBe(30 * 24 * 60 * 60 * 1000);
    expect(parseDuration('12h')).toBe(12 * 3600 * 1000);
    expect(parseDuration(undefined)).toBe(Infinity);
    // empty string is treated like undefined (no window) -> Infinity
    expect(parseDuration('')).toBe(Infinity);
    expect(() => parseDuration('abc')).toThrow(ConfigError);
  });
});

describe('detector.ambient validation', () => {
  it('DEFAULT_CONFIG.detector.ambient equals the verbatim spec object', () => {
    expect(DEFAULT_CONFIG.detector.ambient).toEqual({
      breadth_floor: 4,
      file_depth_floor: 12,
      struggle_rate_threshold: 0.3,
      min_sessions: 10,
      severity_min_sessions: 20,
    });
  });

  it('throws ConfigError naming struggle_rate_threshold when it is 1.5', () => {
    const path = writeTmpConfig(
      'detector:\n  ambient:\n    struggle_rate_threshold: 1.5\n',
    );
    try {
      loadConfig(path);
      throw new Error('expected loadConfig to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toContain(
        'detector.ambient.struggle_rate_threshold',
      );
    }
  });

  it('throws ConfigError when breadth_floor is 0', () => {
    const path = writeTmpConfig(
      'detector:\n  ambient:\n    breadth_floor: 0\n',
    );
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  it('throws ConfigError when min_sessions is 0', () => {
    const path = writeTmpConfig(
      'detector:\n  ambient:\n    min_sessions: 0\n',
    );
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  it('throws ConfigError when severity_min_sessions (5) < min_sessions (10)', () => {
    const path = writeTmpConfig(
      'detector:\n  ambient:\n    severity_min_sessions: 5\n',
    );
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  it('valid override breadth_floor: 8 deep-merges and loads', () => {
    const path = writeTmpConfig(
      'detector:\n  ambient:\n    breadth_floor: 8\n',
    );
    const cfg = loadConfig(path);
    expect(cfg.detector.ambient.breadth_floor).toBe(8);
    // untouched defaults preserved
    expect(cfg.detector.ambient.file_depth_floor).toBe(12);
    expect(cfg.detector.ambient.struggle_rate_threshold).toBe(0.3);
    expect(cfg.detector.ambient.min_sessions).toBe(10);
    expect(cfg.detector.ambient.severity_min_sessions).toBe(20);
  });
});
