/**
 * Input Validator Tests
 *
 * Tests for filename validation, path validation, username validation,
 * category validation, and input sanitization.
 *
 * Ported from DollhouseMCP/mcp-server-v2-refactor tests/unit/InputValidator.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateFilename,
  validatePath,
  validateUsername,
  validateCategory,
  sanitizeInput,
} from '../../src/security/sanitizers/input-validator.js';

describe('InputValidator', () => {
  describe('validateFilename', () => {
    it('should accept valid filenames', () => {
      const validFilenames = ['sample.md', 'my-persona.yaml', 'character_2025.json'];
      for (const filename of validFilenames) {
        assert.doesNotThrow(() => validateFilename(filename));
      }
    });

    it('should reject overly long filenames', () => {
      const longFilename = 'a'.repeat(256);
      assert.throws(() => validateFilename(longFilename), /Filename too long/);
    });

    it('should reject empty or invalid types', () => {
      assert.throws(() => validateFilename(''), /Filename must be a non-empty string/);
      assert.throws(() => validateFilename(null as any), /Filename must be a non-empty string/);
      assert.throws(() => validateFilename(123 as any), /Filename must be a non-empty string/);
    });

    it('should reject path traversal attempts by sanitizing', () => {
      const maliciousFilenames = [
        '../../../etc/passwd',
        '..\\..\\windows\\system32',
      ];
      for (const filename of maliciousFilenames) {
        try {
          const result = validateFilename(filename);
          assert.notEqual(result, filename);
        } catch {
          // Throwing is also acceptable
        }
      }
    });
  });

  describe('validatePath', () => {
    it('should accept valid paths', () => {
      const validPaths = [
        'personas/creative/writer.md',
        'test/path/to/file.yaml',
        'simple.md',
      ];
      for (const p of validPaths) {
        assert.doesNotThrow(() => validatePath(p));
      }
    });

    it('should reject path traversal with various techniques', () => {
      const traversalPaths = [
        '../../../etc/passwd',
        'test/../../secret',
        'personas/../../../.env',
      ];
      for (const p of traversalPaths) {
        assert.throws(() => validatePath(p));
      }
    });

    it('should reject paths with dangerous characters', () => {
      const dangerousPaths = [
        'test;rm -rf /',
        'test|cat /etc/passwd',
        'test&whoami',
      ];
      for (const p of dangerousPaths) {
        assert.throws(() => validatePath(p), /Invalid path format/);
      }
    });
  });

  describe('validateUsername', () => {
    it('should accept valid usernames', () => {
      const validUsernames = ['john_doe', 'user123', 'test.user', 'alice-smith'];
      for (const username of validUsernames) {
        const result = validateUsername(username);
        assert.equal(result, username.toLowerCase());
      }
    });

    it('should reject SQL injection attempts', () => {
      const sqlInjections = [
        "admin' OR '1'='1",
        "user'; DROP TABLE users--",
      ];
      for (const username of sqlInjections) {
        assert.throws(() => validateUsername(username), /Invalid username format/);
      }
    });

    it('should reject empty or invalid types', () => {
      assert.throws(() => validateUsername(''), /Username must be a non-empty string/);
      assert.throws(() => validateUsername(null as any), /Username must be a non-empty string/);
    });
  });

  describe('validateCategory', () => {
    it('should accept valid categories', () => {
      const result = validateCategory('code-analysis');
      assert.equal(result, 'code-analysis');
    });

    it('should reject invalid categories', () => {
      assert.throws(() => validateCategory(''), /Category must be a non-empty string/);
      assert.throws(() => validateCategory('123invalid'), /Invalid category format/);
    });
  });

  describe('sanitizeInput', () => {
    it('should remove control characters', () => {
      const input = 'test\x00\x01\x02value';
      const result = sanitizeInput(input);
      assert.equal(result, 'testvalue');
    });

    it('should remove HTML-dangerous characters', () => {
      const input = 'test<script>alert("xss")</script>';
      const result = sanitizeInput(input);
      assert.ok(!result.includes('<'));
      assert.ok(!result.includes('>'));
    });

    it('should remove shell metacharacters', () => {
      const input = 'test;rm -rf /;echo done';
      const result = sanitizeInput(input);
      assert.ok(!result.includes(';'));
    });

    it('should limit length', () => {
      const longInput = 'a'.repeat(2000);
      const result = sanitizeInput(longInput, 100);
      assert.equal(result.length, 100);
    });

    it('should return empty string for invalid input', () => {
      assert.equal(sanitizeInput(''), '');
      assert.equal(sanitizeInput(null as any), '');
      assert.equal(sanitizeInput(123 as any), '');
    });
  });
});
