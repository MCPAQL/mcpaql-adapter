/**
 * Input Normalizer Tests
 *
 * Tests recursive normalization of nested objects and arrays,
 * string normalization, issue aggregation, and severity escalation.
 *
 * Ported from DollhouseMCP/mcp-server-v2-refactor tests/unit/security/InputNormalizer.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InputNormalizer } from '../../src/security/sanitizers/input-normalizer.js';

describe('InputNormalizer', () => {
  describe('normalize - Basic Types', () => {
    it('should normalize simple string values', () => {
      const result = InputNormalizer.normalize('hello world');

      assert.equal(result.data, 'hello world');
      assert.equal(result.hasIssues, false);
      assert.equal(result.hasCriticalIssues, false);
      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.warnings, []);
    });

    it('should preserve null and undefined values', () => {
      assert.equal(InputNormalizer.normalize(null).data, null);
      assert.equal(InputNormalizer.normalize(undefined).data, undefined);
    });

    it('should preserve number values', () => {
      const result = InputNormalizer.normalize(42);
      assert.equal(result.data, 42);
      assert.equal(result.hasIssues, false);
    });

    it('should preserve boolean values', () => {
      const result = InputNormalizer.normalize(true);
      assert.equal(result.data, true);
      assert.equal(result.hasIssues, false);
    });
  });

  describe('normalize - Unicode Normalization', () => {
    it('should remove zero-width characters', () => {
      const input = 'test\u200Bvalue';
      const result = InputNormalizer.normalize(input);

      assert.equal(result.data, 'testvalue');
      assert.equal(result.hasIssues, true);
      assert.ok(result.warnings.includes('$: Zero-width or non-printable characters detected'));
    });

    it('should remove direction override characters', () => {
      const input = 'test\u202Evalue';
      const result = InputNormalizer.normalize(input);

      assert.equal(result.data, 'testvalue');
      assert.equal(result.hasIssues, true);
      assert.ok(result.errors.length > 0);
      assert.equal(result.maxSeverity, 'high');
    });

    it('should normalize confusable characters', () => {
      const input = '\u0430dmin'; // Cyrillic 'a'
      const result = InputNormalizer.normalize(input);

      assert.equal(result.data, 'admin');
      assert.equal(result.hasIssues, true);
      assert.equal(result.maxSeverity, 'high');
    });

    it('should detect mixed script attacks', () => {
      const input = 'admin\u0430'; // Latin 'admin' + Cyrillic 'a'
      const result = InputNormalizer.normalize(input);

      assert.equal(result.hasIssues, true);
      assert.equal(result.maxSeverity, 'high');
    });
  });

  describe('normalize - Object Structures', () => {
    it('should recursively normalize object properties', () => {
      const input = {
        name: 'test\u200Bname',
        description: 'test\u200Bdesc',
        value: 'clean',
      };

      const result = InputNormalizer.normalize(input);

      assert.deepEqual(result.data, {
        name: 'testname',
        description: 'testdesc',
        value: 'clean',
      });
      assert.equal(result.hasIssues, true);
      assert.ok(result.warnings.includes('$.name: Zero-width or non-printable characters detected'));
      assert.ok(result.warnings.includes('$.description: Zero-width or non-printable characters detected'));
    });

    it('should preserve non-string properties in objects', () => {
      const input = {
        name: 'test',
        age: 25,
        active: true,
        metadata: null,
      };

      const result = InputNormalizer.normalize(input);

      assert.deepEqual(result.data, {
        name: 'test',
        age: 25,
        active: true,
        metadata: null,
      });
      assert.equal(result.hasIssues, false);
    });

    it('should handle deeply nested objects', () => {
      const input = {
        level1: { level2: { level3: { value: 'test\u200Bvalue' } } },
      };

      const result = InputNormalizer.normalize(input);

      assert.deepEqual(result.data, {
        level1: { level2: { level3: { value: 'testvalue' } } },
      });
      assert.equal(result.hasIssues, true);
      assert.ok(result.warnings.includes('$.level1.level2.level3.value: Zero-width or non-printable characters detected'));
    });
  });

  describe('normalize - Array Structures', () => {
    it('should recursively normalize array elements', () => {
      const input = ['test\u200Bvalue1', 'test\u200Bvalue2', 'clean'];

      const result = InputNormalizer.normalize(input);

      assert.deepEqual(result.data, ['testvalue1', 'testvalue2', 'clean']);
      assert.equal(result.hasIssues, true);
      assert.ok(result.warnings.includes('$[0]: Zero-width or non-printable characters detected'));
      assert.ok(result.warnings.includes('$[1]: Zero-width or non-printable characters detected'));
    });

    it('should preserve non-string elements in arrays', () => {
      const input = [1, true, null, 'test'];

      const result = InputNormalizer.normalize(input);

      assert.deepEqual(result.data, [1, true, null, 'test']);
      assert.equal(result.hasIssues, false);
    });

    it('should handle arrays of objects', () => {
      const input = [
        { name: 'test\u200B1' },
        { name: 'test\u200B2' },
      ];

      const result = InputNormalizer.normalize(input);

      assert.deepEqual(result.data, [
        { name: 'test1' },
        { name: 'test2' },
      ]);
      assert.equal(result.hasIssues, true);
      assert.ok(result.warnings.includes('$[0].name: Zero-width or non-printable characters detected'));
      assert.ok(result.warnings.includes('$[1].name: Zero-width or non-printable characters detected'));
    });
  });

  describe('needsNormalization', () => {
    it('should return false for clean strings', () => {
      assert.equal(InputNormalizer.needsNormalization('hello world'), false);
    });

    it('should return true for strings with dangerous Unicode', () => {
      assert.equal(InputNormalizer.needsNormalization('test\u202Evalue'), true);
    });

    it('should check nested objects', () => {
      assert.equal(InputNormalizer.needsNormalization({ a: 'test\u200Bvalue' }), true);
      assert.equal(InputNormalizer.needsNormalization({ a: 'clean' }), false);
    });

    it('should check arrays', () => {
      assert.equal(InputNormalizer.needsNormalization(['test\u200Bvalue']), true);
      assert.equal(InputNormalizer.needsNormalization(['clean']), false);
    });
  });
});
