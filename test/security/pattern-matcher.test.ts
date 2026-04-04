/**
 * Pattern Matcher Tests
 *
 * Tests for glob-like pattern matching used in tool classification
 * and policy evaluation.
 *
 * Ported from DollhouseMCP/mcp-server-v2-refactor tests/unit/utils/patternMatcher.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesPattern,
  globToRegex,
  detectPatternConflict,
  findPatternConflicts,
  MAX_GLOB_PATTERN_LENGTH,
  MAX_PATTERN_MATCH_TEXT_LENGTH,
} from '../../src/security/utils/pattern-matcher.js';

describe('patternMatcher', () => {
  describe('matchesPattern', () => {
    describe('exact matches', () => {
      it('should match identical strings', () => {
        assert.equal(matchesPattern('deploy', 'deploy'), true);
      });

      it('should be case-insensitive', () => {
        assert.equal(matchesPattern('Deploy', 'deploy'), true);
        assert.equal(matchesPattern('DEPLOY', 'deploy'), true);
        assert.equal(matchesPattern('deploy', 'DEPLOY'), true);
      });

      it('should not match different strings', () => {
        assert.equal(matchesPattern('deploy', 'delete'), false);
      });
    });

    describe('wildcard * (any sequence)', () => {
      it('should match * at the end', () => {
        assert.equal(matchesPattern('deploy_prod', 'deploy_*'), true);
        assert.equal(matchesPattern('deploy_staging', 'deploy_*'), true);
        assert.equal(matchesPattern('deploy_', 'deploy_*'), true);
      });

      it('should match * at the beginning', () => {
        assert.equal(matchesPattern('prod_deploy', '*_deploy'), true);
        assert.equal(matchesPattern('staging_deploy', '*_deploy'), true);
      });

      it('should match * in the middle', () => {
        assert.equal(matchesPattern('deploy_to_prod', 'deploy_*_prod'), true);
        assert.equal(matchesPattern('deploy_via_prod', 'deploy_*_prod'), true);
      });

      it('should match multiple *', () => {
        assert.equal(matchesPattern('a_b_c_d', 'a_*_*_d'), true);
        assert.equal(matchesPattern('start_middle_end', '*_middle_*'), true);
      });

      it('should match empty string for *', () => {
        assert.equal(matchesPattern('deploy_prod', 'deploy_*prod'), true);
      });

      it('should not match when prefix/suffix differs', () => {
        assert.equal(matchesPattern('delete_prod', 'deploy_*'), false);
        assert.equal(matchesPattern('prod_delete', '*_deploy'), false);
      });
    });

    describe('wildcard ? (single character)', () => {
      it('should match exactly one character', () => {
        assert.equal(matchesPattern('file1', 'file?'), true);
        assert.equal(matchesPattern('fileA', 'file?'), true);
      });

      it('should not match zero characters', () => {
        assert.equal(matchesPattern('file', 'file?'), false);
      });

      it('should not match multiple characters', () => {
        assert.equal(matchesPattern('file12', 'file?'), false);
      });

      it('should match multiple ?', () => {
        assert.equal(matchesPattern('ab', '??'), true);
        assert.equal(matchesPattern('abc', '???'), true);
        assert.equal(matchesPattern('a', '??'), false);
      });
    });

    describe('combined wildcards', () => {
      it('should handle * and ? together', () => {
        assert.equal(matchesPattern('file1_backup', 'file?_*'), true);
        assert.equal(matchesPattern('fileA_backup_2024', 'file?_*'), true);
      });
    });

    describe('special regex characters', () => {
      it('should escape dots', () => {
        assert.equal(matchesPattern('file.txt', 'file.txt'), true);
        assert.equal(matchesPattern('filextxt', 'file.txt'), false);
      });

      it('should escape other regex chars', () => {
        assert.equal(matchesPattern('test(1)', 'test(1)'), true);
        assert.equal(matchesPattern('test[1]', 'test[1]'), true);
        assert.equal(matchesPattern('test^end', 'test^end'), true);
        assert.equal(matchesPattern('test$end', 'test$end'), true);
      });
    });
  });

  describe('globToRegex', () => {
    it('should convert simple pattern to regex', () => {
      const regex = globToRegex('deploy');
      assert.equal(regex.test('deploy'), true);
      assert.equal(regex.test('Deploy'), true);
    });

    it('should convert * to .*', () => {
      const regex = globToRegex('deploy_*');
      assert.ok(regex.source.includes('.*'));
    });

    it('should convert ? to .', () => {
      const regex = globToRegex('file?');
      assert.ok(regex.source.includes('.'));
    });
  });

  describe('detectPatternConflict', () => {
    it('should detect exact match conflict', () => {
      const result = detectPatternConflict('deploy_prod', 'deploy_prod');
      assert.equal(result.conflicts, true);
      assert.equal(result.reason, 'exact match');
    });

    it('should detect case-insensitive exact match', () => {
      const result = detectPatternConflict('Deploy_Prod', 'deploy_prod');
      assert.equal(result.conflicts, true);
      assert.equal(result.reason, 'exact match');
    });

    it('should detect when specific pattern matches glob pattern', () => {
      const result = detectPatternConflict('deploy_*', 'deploy_prod');
      assert.equal(result.conflicts, true);
      assert.ok(result.reason!.includes("'deploy_prod' matches pattern 'deploy_*'"));
    });

    it('should detect when glob pattern matches specific pattern', () => {
      const result = detectPatternConflict('deploy_prod', 'deploy_*');
      assert.equal(result.conflicts, true);
      assert.ok(result.reason!.includes("'deploy_prod' matches pattern 'deploy_*'"));
    });

    it('should not detect conflict for non-overlapping patterns', () => {
      const result = detectPatternConflict('deploy_*', 'delete_*');
      assert.equal(result.conflicts, false);
    });

    it('should not detect conflict for different specific patterns', () => {
      const result = detectPatternConflict('deploy_prod', 'deploy_staging');
      assert.equal(result.conflicts, false);
    });

    it('should detect conflict with ? wildcard', () => {
      const result = detectPatternConflict('file?', 'file1');
      assert.equal(result.conflicts, true);
    });
  });

  describe('findPatternConflicts', () => {
    it('should find no conflicts between non-overlapping patterns', () => {
      const conflicts = findPatternConflicts(
        ['deploy_*', 'build_*'],
        ['delete_*', 'clean_*']
      );
      assert.equal(conflicts.length, 0);
    });

    it('should find exact match conflicts', () => {
      const conflicts = findPatternConflicts(['deploy_prod'], ['deploy_prod']);
      assert.equal(conflicts.length, 1);
      assert.ok(conflicts[0].includes('exact match'));
    });

    it('should find glob pattern conflicts', () => {
      const conflicts = findPatternConflicts(
        ['deploy_*'],
        ['deploy_prod', 'deploy_staging']
      );
      assert.equal(conflicts.length, 2);
      assert.ok(conflicts[0].includes('deploy_prod'));
      assert.ok(conflicts[1].includes('deploy_staging'));
    });

    it('should find conflicts in both directions', () => {
      const conflicts = findPatternConflicts(['deploy_prod'], ['deploy_*']);
      assert.equal(conflicts.length, 1);
      assert.ok(conflicts[0].includes('deploy_prod'));
    });

    it('should handle empty arrays', () => {
      assert.equal(findPatternConflicts([], ['deploy_*']).length, 0);
      assert.equal(findPatternConflicts(['deploy_*'], []).length, 0);
      assert.equal(findPatternConflicts([], []).length, 0);
    });

    it('should find multiple overlapping conflicts', () => {
      const conflicts = findPatternConflicts(
        ['*_prod', 'deploy_*'],
        ['deploy_prod']
      );
      assert.equal(conflicts.length, 2);
    });
  });

  describe('input validation', () => {
    describe('glob pattern length limits', () => {
      it('should return never-matching regex when pattern exceeds MAX_GLOB_PATTERN_LENGTH', () => {
        const oversizedPattern = 'a'.repeat(MAX_GLOB_PATTERN_LENGTH + 1);
        const regex = globToRegex(oversizedPattern);
        assert.equal(regex.test(oversizedPattern), false);
        assert.equal(regex.test('anything'), false);
      });

      it('should still work when pattern is exactly at the limit', () => {
        const atLimitPattern = 'deploy_' + '*'.repeat(MAX_GLOB_PATTERN_LENGTH - 7);
        const regex = globToRegex(atLimitPattern);
        assert.ok(regex);
        assert.notEqual(regex.source, '(?!)');
      });
    });

    describe('text length limits for matchesPattern', () => {
      it('should return false when text exceeds MAX_PATTERN_MATCH_TEXT_LENGTH', () => {
        const oversizedText = 'a'.repeat(MAX_PATTERN_MATCH_TEXT_LENGTH + 1);
        assert.equal(matchesPattern(oversizedText, '*'), false);
      });

      it('should still work when text is exactly at the limit', () => {
        const atLimitText = 'a'.repeat(MAX_PATTERN_MATCH_TEXT_LENGTH);
        assert.equal(matchesPattern(atLimitText, '*'), true);
      });
    });
  });
});
