/**
 * Unicode Validator
 *
 * Prevents Unicode-based bypass attacks including:
 * - Homograph attacks (visually similar characters)
 * - Direction override attacks (RLO/LRO)
 * - Mixed script attacks
 * - Zero-width character injection
 * - Unicode normalization bypasses
 *
 * Ported from DollhouseMCP/mcp-server-v2-refactor src/security/validators/unicodeValidator.ts
 * Zero DollhouseMCP imports.
 *
 * @module
 */

import type { UnicodeValidationResult, SecuritySeverity } from '../types.js';

export class UnicodeValidator {
  /**
   * Direction override characters that can hide or reverse text display
   * U+202A-U+202E: Left/Right embedding and override marks (LRE, RLE, PDF, LRO, RLO)
   * U+2066-U+2069: Isolate formatting characters (LRI, RLI, FSI, PDI)
   */
  private static readonly DIRECTION_OVERRIDE_CHARS = /[\u202A-\u202E\u2066-\u2069]/g;

  /**
   * Zero-width and invisible formatting characters often used to hide payloads
   * U+200B-U+200F: Zero-width spaces and directional marks
   * U+2028-U+202F: Line/paragraph separators and formatting characters
   * U+FEFF: Zero-width no-break space (Byte Order Mark)
   */
  private static readonly ZERO_WIDTH_CHARS = /[\u200B-\u200F\u2028-\u202F\uFEFF]/g;

  /**
   * Non-printable control characters that should not appear in normal text
   * U+0000-U+0008, U+000B-U+000C, U+000E-U+001F: C0 control codes (except TAB, LF, CR)
   * U+007F-U+009F: Delete and C1 control codes
   * U+FFFE-U+FFFF: Non-characters that should never appear in valid text
   */
  // eslint-disable-next-line no-control-regex
  private static readonly NON_PRINTABLE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFE\uFFFF]/g;

  /**
   * Common homograph/confusable character mappings.
   * Maps visually similar Unicode characters to their ASCII equivalents.
   */
  private static readonly CONFUSABLE_MAPPINGS: Map<string, string> = new Map([
    // Cyrillic to Latin
    ['\u0430', 'a'], ['\u0435', 'e'], ['\u043E', 'o'], ['\u0440', 'p'], ['\u0441', 'c'], ['\u0445', 'x'], ['\u0443', 'y'],
    ['\u0410', 'A'], ['\u0412', 'B'], ['\u0415', 'E'], ['\u041A', 'K'], ['\u041C', 'M'], ['\u041D', 'H'], ['\u041E', 'O'],
    ['\u0420', 'P'], ['\u0421', 'C'], ['\u0422', 'T'], ['\u0423', 'Y'], ['\u0425', 'X'],

    // Greek to Latin
    ['\u03B1', 'a'], ['\u03B2', 'b'], ['\u03B3', 'g'], ['\u03B4', 'd'], ['\u03B5', 'e'], ['\u03B6', 'z'], ['\u03B7', 'h'],
    ['\u03B8', 'th'], ['\u03B9', 'i'], ['\u03BA', 'k'], ['\u03BB', 'l'], ['\u03BC', 'm'], ['\u03BD', 'n'], ['\u03BE', 'x'],
    ['\u03BF', 'o'], ['\u03C0', 'p'], ['\u03C1', 'r'], ['\u03C3', 's'], ['\u03C4', 't'], ['\u03C5', 'u'], ['\u03C6', 'f'],
    ['\u03C7', 'ch'], ['\u03C8', 'ps'], ['\u03C9', 'w'],

    // Mathematical symbols to ASCII (script style)
    ['\uD835\uDC82', 'a'], ['\uD835\uDC83', 'b'], ['\uD835\uDC84', 'c'], ['\uD835\uDC85', 'd'], ['\uD835\uDC86', 'e'],
    ['\uD835\uDC87', 'f'], ['\uD835\uDC88', 'g'], ['\uD835\uDC89', 'h'], ['\uD835\uDC8A', 'i'], ['\uD835\uDC8B', 'j'],
    ['\uD835\uDC8C', 'k'], ['\uD835\uDC8D', 'l'], ['\uD835\uDC8E', 'm'], ['\uD835\uDC8F', 'n'], ['\uD835\uDC90', 'o'],
    ['\uD835\uDC91', 'p'], ['\uD835\uDC92', 'q'], ['\uD835\uDC93', 'r'], ['\uD835\uDC94', 's'], ['\uD835\uDC95', 't'],
    ['\uD835\uDC96', 'u'], ['\uD835\uDC97', 'v'], ['\uD835\uDC98', 'w'], ['\uD835\uDC99', 'x'], ['\uD835\uDC9A', 'y'],
    ['\uD835\uDC9B', 'z'],
    // Mathematical symbols to ASCII (bold style)
    ['\uD835\uDC1A', 'a'], ['\uD835\uDC1B', 'b'], ['\uD835\uDC1C', 'c'], ['\uD835\uDC1D', 'd'], ['\uD835\uDC1E', 'e'],
    ['\uD835\uDC1F', 'f'], ['\uD835\uDC20', 'g'], ['\uD835\uDC21', 'h'], ['\uD835\uDC22', 'i'], ['\uD835\uDC23', 'j'],
    ['\uD835\uDC24', 'k'], ['\uD835\uDC25', 'l'], ['\uD835\uDC26', 'm'], ['\uD835\uDC27', 'n'], ['\uD835\uDC28', 'o'],
    ['\uD835\uDC29', 'p'], ['\uD835\uDC2A', 'q'], ['\uD835\uDC2B', 'r'], ['\uD835\uDC2C', 's'], ['\uD835\uDC2D', 't'],
    ['\uD835\uDC2E', 'u'], ['\uD835\uDC2F', 'v'], ['\uD835\uDC30', 'w'], ['\uD835\uDC31', 'x'], ['\uD835\uDC32', 'y'],
    ['\uD835\uDC33', 'z'],

    // Special i variants (Turkish, etc.)
    ['\u0131', 'i'], ['\u0130', 'I'], ['\u0456', 'i'], ['\u04C0', 'I'],

    // Other common confusables
    ['\u01DD', 'e'], ['\u0250', 'a'], ['\u0254', 'o'], ['\u0287', 't'], ['\u028C', 'v'], ['\u028D', 'w'],
    ['\u2103', 'C'], ['\u2109', 'F'], ['\u2116', 'No'], ['\u2122', 'TM'], ['\u00AE', 'R'],

    // Fullwidth characters
    ['\uFF21', 'A'], ['\uFF22', 'B'], ['\uFF23', 'C'], ['\uFF24', 'D'], ['\uFF25', 'E'], ['\uFF26', 'F'],
    ['\uFF27', 'G'], ['\uFF28', 'H'], ['\uFF29', 'I'], ['\uFF2A', 'J'], ['\uFF2B', 'K'], ['\uFF2C', 'L'],
    ['\uFF2D', 'M'], ['\uFF2E', 'N'], ['\uFF2F', 'O'], ['\uFF30', 'P'], ['\uFF31', 'Q'], ['\uFF32', 'R'],
    ['\uFF33', 'S'], ['\uFF34', 'T'], ['\uFF35', 'U'], ['\uFF36', 'V'], ['\uFF37', 'W'], ['\uFF38', 'X'],
    ['\uFF39', 'Y'], ['\uFF3A', 'Z'],
    ['\uFF41', 'a'], ['\uFF42', 'b'], ['\uFF43', 'c'], ['\uFF44', 'd'], ['\uFF45', 'e'], ['\uFF46', 'f'],
    ['\uFF47', 'g'], ['\uFF48', 'h'], ['\uFF49', 'i'], ['\uFF4A', 'j'], ['\uFF4B', 'k'], ['\uFF4C', 'l'],
    ['\uFF4D', 'm'], ['\uFF4E', 'n'], ['\uFF4F', 'o'], ['\uFF50', 'p'], ['\uFF51', 'q'], ['\uFF52', 'r'],
    ['\uFF53', 's'], ['\uFF54', 't'], ['\uFF55', 'u'], ['\uFF56', 'v'], ['\uFF57', 'w'], ['\uFF58', 'x'],
    ['\uFF59', 'y'], ['\uFF5A', 'z'],
    ['\uFF10', '0'], ['\uFF11', '1'], ['\uFF12', '2'], ['\uFF13', '3'], ['\uFF14', '4'],
    ['\uFF15', '5'], ['\uFF16', '6'], ['\uFF17', '7'], ['\uFF18', '8'], ['\uFF19', '9'],
  ]);

  /**
   * Script mixing detection patterns
   */
  private static readonly SCRIPT_PATTERNS: Record<string, RegExp> = {
    // eslint-disable-next-line no-control-regex
    LATIN: /[\u0000-\u007F\u00A0-\u00FF\u0100-\u017F\u0180-\u024F]/,
    CYRILLIC: /(?:[\u0400-\u04FF]|[\u0500-\u052F]|[\u2DE0-\u2DFF]|[\uA640-\uA69F])/,
    GREEK: /[\u0370-\u03FF\u1F00-\u1FFF]/,
    ARABIC: /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/,
    HEBREW: /[\u0590-\u05FF\uFB1D-\uFB4F]/,
    CJK: /[\u2E80-\u2EFF\u2F00-\u2FDF\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u3100-\u312F\u3130-\u318F\u3190-\u319F\u31A0-\u31BF\u31C0-\u31EF\u31F0-\u31FF\u3200-\u32FF\u3300-\u33FF\u3400-\u4DBF\u4DC0-\u4DFF\u4E00-\u9FFF]/,
  };

  /**
   * Normalize Unicode content to prevent bypass attacks
   */
  static normalize(content: string): UnicodeValidationResult {
    const issues: string[] = [];
    let normalized = content;
    let severity: SecuritySeverity = 'low';

    try {
      // 1. Detect and log suspicious Unicode patterns before normalization
      const suspiciousPatterns = this.detectSuspiciousPatterns(content);
      issues.push(...suspiciousPatterns.issues);
      if (suspiciousPatterns.severity) {
        severity = this.escalateSeverity(severity, suspiciousPatterns.severity);
      }

      // 2. Remove direction override characters (prevents RLO/LRO attacks)
      if (this.DIRECTION_OVERRIDE_CHARS.test(normalized)) {
        issues.push('Direction override characters detected');
        severity = this.escalateSeverity(severity, 'high');
        normalized = normalized.replace(this.DIRECTION_OVERRIDE_CHARS, '');
      }

      // 3. Remove zero-width and non-printable characters
      if (this.ZERO_WIDTH_CHARS.test(normalized) || this.NON_PRINTABLE_CHARS.test(normalized)) {
        const hasDirectionMarks = /[\u200E\u200F]/.test(normalized);
        if (hasDirectionMarks) {
          issues.push('Direction marks (LRM/RLM) detected');
          severity = this.escalateSeverity(severity, 'high');
        } else {
          issues.push('Zero-width or non-printable characters detected');
          severity = this.escalateSeverity(severity, 'medium');
        }
        normalized = normalized
          .replace(this.ZERO_WIDTH_CHARS, '')
          .replace(this.NON_PRINTABLE_CHARS, '');
      }

      // 4. Apply Unicode normalization (NFC)
      normalized = normalized.normalize('NFC');

      // 5. Detect mixed script attacks BEFORE confusable replacement
      const mixedScriptResult = this.detectMixedScripts(normalized);
      if (mixedScriptResult.isSuspicious) {
        issues.push(`Mixed script usage detected: ${mixedScriptResult.scripts.join(', ')}`);
        severity = this.escalateSeverity(severity, 'high');
      }

      // 6. Always replace confusable characters with ASCII equivalents
      const confusableResult = this.replaceConfusables(normalized);
      if (confusableResult.hasConfusables) {
        normalized = confusableResult.normalized;
        issues.push('Confusable Unicode characters detected and normalized');
        severity = this.escalateSeverity(severity, 'medium');
      }

      return {
        isValid: issues.length === 0,
        normalizedContent: normalized,
        detectedIssues: issues.length > 0 ? issues : undefined,
        severity: issues.length > 0 ? severity : undefined,
      };
    } catch (error) {
      return {
        isValid: false,
        normalizedContent: content,
        detectedIssues: ['Unicode validation failed'],
        severity: 'high',
      };
    }
  }

  /**
   * Detect suspicious Unicode patterns that might indicate attacks
   */
  private static detectSuspiciousPatterns(content: string): { issues: string[]; severity?: SecuritySeverity } {
    const issues: string[] = [];
    let severity: SecuritySeverity | undefined;

    // Check for excessive Unicode escapes
    const unicodeEscapePattern = /\\u[0-9a-fA-F]{4}/g;
    const unicodeEscapes = content.match(unicodeEscapePattern);
    if (unicodeEscapes && unicodeEscapes.length > 10) {
      issues.push(`Excessive Unicode escapes detected (${unicodeEscapes.length})`);
      severity = 'high';
    }

    // Check for suspicious Unicode ranges
    const suspiciousRanges = [
      { range: /[\uE000-\uF8FF]/g, name: 'Private Use Area' },
      { range: /[\uFDD0-\uFDEF]/g, name: 'Non-characters' },
      { range: /[\uFFFE\uFFFF]/g, name: 'Non-characters' },
    ];

    for (const { range, name } of suspiciousRanges) {
      if (range.test(content)) {
        issues.push(`Suspicious Unicode range detected: ${name}`);
        severity = this.escalateSeverity(severity, 'medium');
      }
    }

    // Check for malformed surrogate pairs
    if (this.hasMalformedSurrogates(content)) {
      issues.push('Malformed surrogate pairs detected');
      severity = this.escalateSeverity(severity, 'high');
    }

    return { issues, severity };
  }

  /**
   * Replace confusable Unicode characters with ASCII equivalents
   */
  private static replaceConfusables(content: string): { normalized: string; hasConfusables: boolean } {
    let normalized = content;
    let hasConfusables = false;

    for (const [confusable, replacement] of this.CONFUSABLE_MAPPINGS) {
      if (normalized.includes(confusable)) {
        normalized = normalized.replace(new RegExp(this.escapeRegex(confusable), 'g'), replacement);
        hasConfusables = true;
      }
    }

    return { normalized, hasConfusables };
  }

  /**
   * Detect suspicious mixing of different Unicode scripts
   */
  private static detectMixedScripts(content: string): { isSuspicious: boolean; scripts: string[] } {
    const detectedScripts: string[] = [];

    for (const [scriptName, pattern] of Object.entries(this.SCRIPT_PATTERNS)) {
      if (pattern.test(content)) {
        detectedScripts.push(scriptName);
      }
    }

    const isSuspicious = detectedScripts.length > 3 ||
      (detectedScripts.includes('LATIN') && detectedScripts.length > 1 &&
       (detectedScripts.includes('CYRILLIC') || detectedScripts.includes('GREEK')));

    return { isSuspicious, scripts: detectedScripts };
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
   * Escape special regex characters for safe replacement
   */
  private static escapeRegex(string: string): string {
    return string.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Check if content contains potentially dangerous Unicode patterns
   */
  static containsDangerousUnicode(content: string): boolean {
    return this.DIRECTION_OVERRIDE_CHARS.test(content) ||
           this.ZERO_WIDTH_CHARS.test(content) ||
           this.NON_PRINTABLE_CHARS.test(content) ||
           this.hasExcessiveUnicodeEscapes(content);
  }

  /**
   * Check if content has excessive Unicode escape sequences
   */
  private static hasExcessiveUnicodeEscapes(content: string): boolean {
    const matches = content.match(/\\u[0-9a-fA-F]{4}/g);
    return matches !== null && matches.length > 10;
  }

  /**
   * Safely check for malformed surrogate pairs without ReDoS vulnerability
   */
  private static hasMalformedSurrogates(content: string): boolean {
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);

      // High surrogate (U+D800-U+DBFF)
      if (char >= 0xD800 && char <= 0xDBFF) {
        if (i + 1 >= content.length) return true;
        const nextChar = content.charCodeAt(i + 1);
        if (nextChar < 0xDC00 || nextChar > 0xDFFF) return true;
        i++; // Skip the valid low surrogate
      }
      // Low surrogate without preceding high surrogate
      else if (char >= 0xDC00 && char <= 0xDFFF) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get safe preview of Unicode content for logging
   */
  static getSafePreview(content: string, maxLength: number = 100): string {
    const cleaned = content
      .replace(this.DIRECTION_OVERRIDE_CHARS, '[DIR]')
      .replace(this.ZERO_WIDTH_CHARS, '[ZW]')
      .replace(this.NON_PRINTABLE_CHARS, '[NP]');

    return cleaned.length > maxLength ?
      cleaned.substring(0, maxLength) + '...' :
      cleaned;
  }
}
