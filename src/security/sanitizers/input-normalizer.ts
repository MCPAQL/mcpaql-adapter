/**
 * InputNormalizer - Industry-standard input normalization at the boundary
 *
 * Recursively normalizes ALL string values in input objects using
 * UnicodeValidator.normalize() as the single normalization implementation.
 *
 * Ported from DollhouseMCP/mcp-server-v2-refactor src/security/InputNormalizer.ts
 * Zero DollhouseMCP imports.
 *
 * @module
 */

import type { NormalizationResult, SecuritySeverity } from '../types.js';
import { UnicodeValidator } from '../validators/unicode-validator.js';

export class InputNormalizer {
  /**
   * Normalize all string values in an object/array structure.
   *
   * @param input - Input data to normalize (object, array, or primitive)
   * @param path - Current path in object tree (for error tracking)
   * @returns Normalization result with normalized data and detected issues
   */
  static normalize<T = unknown>(input: T, path: string = '$'): NormalizationResult<T> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const issuesByPath = new Map<string, string[]>();
    let maxSeverity: SecuritySeverity | undefined;

    const normalizeValue = (value: unknown, currentPath: string): unknown => {
      if (value === null || value === undefined) {
        return value;
      }

      if (typeof value === 'string') {
        const unicodeResult = UnicodeValidator.normalize(value);

        if (unicodeResult.detectedIssues && unicodeResult.detectedIssues.length > 0) {
          const pathIssues = unicodeResult.detectedIssues.map(
            issue => `${currentPath}: ${issue}`
          );
          issuesByPath.set(currentPath, unicodeResult.detectedIssues);

          if (unicodeResult.severity) {
            maxSeverity = this.escalateSeverity(maxSeverity, unicodeResult.severity);

            if (unicodeResult.severity === 'critical' || unicodeResult.severity === 'high') {
              errors.push(...pathIssues);
            } else {
              warnings.push(...pathIssues);
            }
          } else {
            warnings.push(...pathIssues);
          }
        }

        return unicodeResult.normalizedContent;
      }

      if (Array.isArray(value)) {
        return value.map((item, index) =>
          normalizeValue(item, `${currentPath}[${index}]`)
        );
      }

      if (typeof value === 'object') {
        const normalized: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
          normalized[key] = normalizeValue(val, `${currentPath}.${key}`);
        }
        return normalized;
      }

      return value;
    };

    const normalizedData = normalizeValue(input, path) as T;

    const hasIssues = errors.length > 0 || warnings.length > 0;
    const hasCriticalIssues = maxSeverity === 'critical';
    const hasHighOrCriticalIssues = maxSeverity === 'critical' || maxSeverity === 'high';

    return {
      data: normalizedData,
      hasIssues,
      hasCriticalIssues,
      hasHighOrCriticalIssues,
      errors,
      warnings,
      issuesByPath,
      maxSeverity,
    };
  }

  /**
   * Escalate severity level (higher severity takes precedence)
   */
  private static escalateSeverity(
    current: SecuritySeverity | undefined,
    newSeverity: SecuritySeverity
  ): SecuritySeverity {
    const severityLevels: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };
    const currentLevel = current ? severityLevels[current] : 0;
    const newLevel = severityLevels[newSeverity];

    return newLevel > currentLevel ? newSeverity : (current || 'low');
  }

  /**
   * Quick check if input needs normalization (has suspicious Unicode).
   */
  static needsNormalization(input: unknown): boolean {
    if (typeof input === 'string') {
      return UnicodeValidator.containsDangerousUnicode(input);
    }

    if (Array.isArray(input)) {
      return input.some(item => this.needsNormalization(item));
    }

    if (input && typeof input === 'object') {
      return Object.values(input as Record<string, unknown>).some(
        value => this.needsNormalization(value)
      );
    }

    return false;
  }
}
