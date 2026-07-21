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

describe('docs_dirs and diagnose config (Slice 4 Task 1)', () => {
  it('DEFAULT_CONFIG.docs_dirs === ["docs"] and diagnose defaults are verbatim', () => {
    expect(DEFAULT_CONFIG.docs_dirs).toEqual(['docs']);
    expect(DEFAULT_CONFIG.diagnose).toEqual({
      confidence_floor: 0.5,
      config_share_floor: 0.5,
      test_share_floor: 0.5,
      code_share_floor: 0.5,
      score_floor: 70,
    });
  });

  it('loadConfig() with no file has docs_dirs === ["docs"] and diagnose.confidence_floor === 0.5', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harnessgap-s4-defaults-'));
    const originalCwd = process.cwd();
    try {
      process.chdir(dir);
      const cfg = loadConfig();
      expect(cfg.docs_dirs).toEqual(['docs']);
      expect(cfg.diagnose.confidence_floor).toBe(0.5);
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loadConfig(path) parses docs_dirs: [doc, docs/arch] to those paths', () => {
    const path = writeTmpConfig('docs_dirs: [doc, docs/arch]\n');
    const cfg = loadConfig(path);
    expect(cfg.docs_dirs).toEqual(['doc', 'docs/arch']);
  });

  it('loadConfig(path) deep-merges diagnose.confidence_floor: 0.6, keeping other diagnose defaults', () => {
    const path = writeTmpConfig('diagnose:\n  confidence_floor: 0.6\n');
    const cfg = loadConfig(path);
    expect(cfg.diagnose.confidence_floor).toBe(0.6);
    // untouched defaults preserved
    expect(cfg.diagnose.config_share_floor).toBe(0.5);
    expect(cfg.diagnose.test_share_floor).toBe(0.5);
    expect(cfg.diagnose.code_share_floor).toBe(0.5);
    expect(cfg.diagnose.score_floor).toBe(70);
  });

  it('loadConfig(path) with unknown top-level key synthesizer: throws ConfigError', () => {
    const path = writeTmpConfig('synthesizer:\n  enabled: true\n');
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  it('throws ConfigError when diagnose.confidence_floor is 1.5 (must be in [0,1])', () => {
    const path = writeTmpConfig('diagnose:\n  confidence_floor: 1.5\n');
    try {
      loadConfig(path);
      throw new Error('expected loadConfig to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toContain('diagnose.confidence_floor');
    }
  });

  it('throws ConfigError when diagnose.config_share_floor is -0.1 (must be in [0,1])', () => {
    const path = writeTmpConfig('diagnose:\n  config_share_floor: -0.1\n');
    try {
      loadConfig(path);
      throw new Error('expected loadConfig to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toContain('diagnose.config_share_floor');
    }
  });

  it('throws ConfigError when diagnose.test_share_floor is 1.5 (must be in [0,1])', () => {
    const path = writeTmpConfig('diagnose:\n  test_share_floor: 1.5\n');
    try {
      loadConfig(path);
      throw new Error('expected loadConfig to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toContain('diagnose.test_share_floor');
    }
  });

  it('throws ConfigError when diagnose.code_share_floor is -0.5 (must be in [0,1])', () => {
    const path = writeTmpConfig('diagnose:\n  code_share_floor: -0.5\n');
    try {
      loadConfig(path);
      throw new Error('expected loadConfig to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toContain('diagnose.code_share_floor');
    }
  });

  it('throws ConfigError when diagnose.score_floor is 200 (must be in [0,100])', () => {
    const path = writeTmpConfig('diagnose:\n  score_floor: 200\n');
    try {
      loadConfig(path);
      throw new Error('expected loadConfig to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toContain('diagnose.score_floor');
    }
  });

  it('throws ConfigError when docs_dirs is a scalar number (must be array of strings)', () => {
    const path = writeTmpConfig('docs_dirs: 5\n');
    try {
      loadConfig(path);
      throw new Error('expected loadConfig to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toContain('docs_dirs');
    }
  });

  it('throws ConfigError when docs_dirs contains a non-string element', () => {
    const path = writeTmpConfig('docs_dirs:\n  - 42\n');
    try {
      loadConfig(path);
      throw new Error('expected loadConfig to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toContain('docs_dirs');
    }
  });

  it('accepts docs_dirs as an array of strings', () => {
    const path = writeTmpConfig("docs_dirs:\n  - docs\n  - wiki\n");
    const cfg = loadConfig(path);
    expect(cfg.docs_dirs).toEqual(['docs', 'wiki']);
  });
});

describe('harness config key (Qwen+GigaCode slice Task 8)', () => {
  it('DEFAULT_CONFIG.harness === "claude-code"', () => {
    expect(DEFAULT_CONFIG.harness).toBe('claude-code');
  });

  it('loadConfig(path) with harness: qwen-code yields cfg.harness === "qwen-code"', () => {
    const path = writeTmpConfig('harness: qwen-code\n');
    const cfg = loadConfig(path);
    expect(cfg.harness).toBe('qwen-code');
  });

  it('loadConfig() with no file defaults to harness === "claude-code" (via deep-merge over DEFAULT_CONFIG)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harnessgap-harness-default-'));
    const originalCwd = process.cwd();
    try {
      process.chdir(dir);
      const cfg = loadConfig();
      expect(cfg.harness).toBe('claude-code');
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loadConfig(path) with harness: wat throws ConfigError naming the invalid value', () => {
    const path = writeTmpConfig('harness: wat\n');
    try {
      loadConfig(path);
      throw new Error('expected loadConfig to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toContain('harness');
      expect((e as Error).message).toContain('wat');
    }
  });

  it('loadConfig(path) with an unknown top-level key still throws ConfigError (allowlist behavior unchanged)', () => {
    const path = writeTmpConfig('totally-bogus: 1\n');
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });
});
