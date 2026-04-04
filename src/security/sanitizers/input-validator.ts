/**
 * Input Validation and Sanitization
 *
 * Provides validation functions for filenames, paths, usernames,
 * categories, and general input sanitization.
 *
 * Ported from DollhouseMCP/mcp-server-v2-refactor src/security/InputValidator.ts
 * Zero DollhouseMCP imports - uses local constants and error patterns.
 *
 * @module
 */

import * as path from 'path';

// ── Security Limits (replaces DollhouseMCP SECURITY_LIMITS import) ──

const SECURITY_LIMITS = {
  MAX_FILENAME_LENGTH: 255,
  MAX_CONTENT_LENGTH: 50_000,
  MAX_YAML_LENGTH: 10_000,
  MAX_METADATA_FIELD_LENGTH: 1_000,
  MAX_PATH_DEPTH: 20,
  MAX_FILE_SIZE: 1_048_576, // 1 MB
};

// ── Validation Patterns (replaces DollhouseMCP VALIDATION_PATTERNS import) ──

const VALIDATION_PATTERNS = {
  SAFE_FILENAME: /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
  SAFE_PATH: /^[a-zA-Z0-9/._-]+$/,
  SAFE_USERNAME: /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,38}$/,
  SAFE_CATEGORY: /^[a-zA-Z][a-zA-Z0-9_-]{0,20}$/,
};

// ── Pre-compiled regex patterns ──

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_REGEX = /[\u0000-\u001F\u007F]/g;
const HTML_DANGEROUS_REGEX = /[<>'"&]/g;
const SHELL_METACHAR_REGEX = /[;&|`$()!\\~*?{}]/g;
const SHELL_METACHAR_DISPLAY_REGEX = /[;&|`$()]/g;
// eslint-disable-next-line no-misleading-character-class
const RTL_ZEROWIDTH_REGEX = /[\u200B\u200C\u200D\u2060\u202E\uFEFF]/g;
const COLLECTION_PATH_CHAR_REGEX = /[a-zA-Z0-9/\-_.]/;
const VALID_COLLECTION_PATH_REGEX = /^[a-zA-Z0-9/\-_.]*$/;
const IPV4_REGEX = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/;
const DECIMAL_IP_REGEX = /^\d{8,10}$/;
const HEX_IP_REGEX = /^0x[0-9a-f]{1,8}$/i;
const OCTAL_IP_REGEX = /^0[0-7]{8,11}$/;
const FILENAME_DANGEROUS_REGEX = /[/\\:*?"<>|]/g;
const FILENAME_LEADING_DOTS_REGEX = /^\.+/;
const URL_PLUS_DECODE_REGEX = /\+/g;

// ── MCPInputValidator ──

export class MCPInputValidator {
  static validatePersonaIdentifier(identifier: string): string {
    if (!identifier || typeof identifier !== 'string') {
      throw new Error('Persona identifier must be a non-empty string');
    }
    if (identifier.length > 100) {
      throw new Error('Persona identifier too long (max 100 characters)');
    }
    const sanitized = sanitizeInput(identifier, 100);
    if (!sanitized) {
      throw new Error('Persona identifier contains only invalid characters');
    }
    return sanitized;
  }

  static validateSearchQuery(query: string): string {
    if (!query || typeof query !== 'string') {
      throw new Error('Search query must be a non-empty string');
    }
    if (query.length < 2) {
      throw new Error('Search query too short (minimum 2 characters)');
    }
    if (query.length > 200) {
      throw new Error('Search query too long (max 200 characters)');
    }
    const sanitized = query
      .replaceAll(CONTROL_CHARS_REGEX, '')
      .replaceAll(HTML_DANGEROUS_REGEX, '')
      .replaceAll(SHELL_METACHAR_REGEX, '')
      .replaceAll(RTL_ZEROWIDTH_REGEX, '')
      .trim();
    if (!sanitized) {
      throw new Error('Search query contains only invalid characters');
    }
    return sanitized;
  }

  static validateCollectionPath(collectionPath: string): string {
    if (!collectionPath || typeof collectionPath !== 'string') {
      throw new Error('Collection path must be a non-empty string');
    }
    if (collectionPath.length > 500) {
      throw new Error('Collection path too long (max 500 characters)');
    }
    if (!VALID_COLLECTION_PATH_REGEX.test(collectionPath)) {
      for (let i = 0; i < collectionPath.length; i++) {
        const char = collectionPath[i];
        if (!COLLECTION_PATH_CHAR_REGEX.test(char)) {
          throw new Error(`Invalid character '${char}' in collection path at position ${i + 1}`);
        }
      }
      throw new Error('Invalid characters in collection path');
    }
    const pathLower = collectionPath.toLowerCase();
    const encodedPath = decodeURIComponent(collectionPath.replaceAll(URL_PLUS_DECODE_REGEX, ' '));
    const traversalPatterns = [
      '..', './', '/../', '\\', '%2e%2e', '%2e%2e%2f', '%2e%2e%5c',
      '%252e%252e', '..%2f', '..%5c', '..../', '..;/',
    ];
    for (const pattern of traversalPatterns) {
      if (pathLower.includes(pattern) || encodedPath.toLowerCase().includes(pattern)) {
        throw new Error('Path traversal not allowed in collection path');
      }
    }
    return collectionPath;
  }

  static validateImportUrl(url: string): string {
    if (!url || typeof url !== 'string') {
      throw new Error('URL must be a non-empty string');
    }
    if (url.length > 2000) {
      throw new Error('URL too long (max 2000 characters)');
    }
    if (url.startsWith('//')) {
      throw new Error('Protocol-relative URLs are not allowed');
    }
    try {
      let decodedUrl = url;
      try { decodedUrl = decodeURIComponent(url); } catch { /* keep original */ }
      const parsed = new URL(decodedUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Only HTTP(S) URLs are allowed');
      }
      let hostname = parsed.hostname.toLowerCase();
      try {
        const idnNormalized = new URL(`http://${hostname}`).hostname;
        hostname = idnNormalized;
      } catch {
        throw new Error('Invalid hostname: IDN conversion failed');
      }
      if (this.isPrivateIP(hostname)) {
        throw new Error('Private network URLs are not allowed');
      }
      if (this.isEncodedPrivateIP(hostname)) {
        throw new Error('Encoded private network URLs are not allowed');
      }
      return url;
    } catch (error) {
      if (error instanceof Error && (error.message.includes('Private network') || error.message.includes('Encoded private'))) {
        throw error;
      }
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Invalid URL format: ${errorMessage}`);
    }
  }

  static validateExpiryDays(days: number): number {
    if (typeof days !== 'number') {
      throw new Error('Expiry days must be a valid number');
    }
    if (Number.isNaN(days) || !Number.isFinite(days)) {
      throw new Error('Expiry days must be a valid number');
    }
    if (days < 1 || days > 365) {
      throw new Error('Expiry days must be between 1 and 365');
    }
    return Math.floor(days);
  }

  static validateConfirmation(confirm: boolean, operationName: string): boolean {
    if (typeof confirm !== 'boolean') {
      throw new Error(`${operationName} confirmation must be a boolean value`);
    }
    if (!confirm) {
      throw new Error(`${operationName} operation requires explicit confirmation (true)`);
    }
    return confirm;
  }

  static validateEditField(field: string): string {
    if (!field || typeof field !== 'string') {
      throw new Error('Field name must be a non-empty string');
    }
    const validFields = [
      'name', 'description', 'category', 'instructions',
      'triggers', 'version', 'author', 'tags',
    ];
    const normalizedField = field.toLowerCase().trim();
    if (!validFields.includes(normalizedField)) {
      throw new Error(`Invalid field name. Must be one of: ${validFields.join(', ')}`);
    }
    return normalizedField;
  }

  static sanitizeForDisplay(text: string): string {
    if (!text || typeof text !== 'string') return '';
    return text.replaceAll(SHELL_METACHAR_DISPLAY_REGEX, '');
  }

  private static isPrivateIP(hostname: string): boolean {
    if (['localhost', '127.0.0.1', '::1'].includes(hostname)) return true;
    const ipv4Match = hostname.match(IPV4_REGEX);
    if (ipv4Match) {
      const [, a, b] = ipv4Match.map(Number);
      if (a === 10) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 169 && b === 254) return true;
    }
    const ipv6Lower = hostname.toLowerCase();
    if (ipv6Lower.startsWith('fc') || ipv6Lower.startsWith('fd')) return true;
    const fe80Range = Number.parseInt(ipv6Lower.substring(0, 4), 16);
    if (fe80Range >= 0xfe80 && fe80Range <= 0xfebf) return true;
    if (['::1', '0:0:0:0:0:0:0:1'].includes(ipv6Lower)) return true;
    return false;
  }

  private static isEncodedPrivateIP(hostname: string): boolean {
    if (DECIMAL_IP_REGEX.test(hostname)) {
      const num = Number.parseInt(hostname, 10);
      if (num >= 0 && num <= 4294967295) {
        const ip = [(num >>> 24) & 255, (num >>> 16) & 255, (num >>> 8) & 255, num & 255].join('.');
        return this.isPrivateIP(ip);
      }
    }
    if (HEX_IP_REGEX.test(hostname)) {
      const num = Number.parseInt(hostname, 16);
      if (num >= 0 && num <= 4294967295) {
        const ip = [(num >>> 24) & 255, (num >>> 16) & 255, (num >>> 8) & 255, num & 255].join('.');
        return this.isPrivateIP(ip);
      }
    }
    if (OCTAL_IP_REGEX.test(hostname)) {
      const num = Number.parseInt(hostname, 8);
      if (num >= 0 && num <= 4294967295) {
        const ip = [(num >>> 24) & 255, (num >>> 16) & 255, (num >>> 8) & 255, num & 255].join('.');
        return this.isPrivateIP(ip);
      }
    }
    return false;
  }
}

// ── Standalone validation functions ──

export function validateFilename(filename: string): string {
  if (!filename || typeof filename !== 'string') {
    throw new Error('Filename must be a non-empty string');
  }
  if (filename.length > SECURITY_LIMITS.MAX_FILENAME_LENGTH) {
    throw new Error(`Filename too long (max ${SECURITY_LIMITS.MAX_FILENAME_LENGTH} characters)`);
  }
  const sanitized = filename.replaceAll(FILENAME_DANGEROUS_REGEX, '').replace(FILENAME_LEADING_DOTS_REGEX, '');
  if (!VALIDATION_PATTERNS.SAFE_FILENAME.test(sanitized)) {
    throw new Error('Invalid filename format. Use alphanumeric characters, hyphens, underscores, and dots only.');
  }
  return sanitized;
}

export function validatePath(inputPath: string, baseDir?: string): string {
  if (!inputPath || typeof inputPath !== 'string') {
    throw new Error('Path must be a non-empty string');
  }
  const isUnixAbsolute = path.isAbsolute(inputPath);
  const isWindowsAbsolute = /^[a-zA-Z]:[\\/]/.test(inputPath);
  if (baseDir && (isUnixAbsolute || isWindowsAbsolute)) {
    throw new Error('Absolute paths not allowed when base directory is specified');
  }
  let normalized = inputPath.replaceAll('\\', '/');
  const isAbsolute = normalized.startsWith('/') || isWindowsAbsolute;
  normalized = normalized.replaceAll(/\/{1,100}$/g, '').replaceAll(/\/{2,100}/g, '/');
  if (isAbsolute && !normalized.startsWith('/') && !isWindowsAbsolute) {
    normalized = '/' + normalized;
  }
  if (!VALIDATION_PATTERNS.SAFE_PATH.test(normalized)) {
    throw new Error('Invalid path format. Use alphanumeric characters, hyphens, underscores, dots, and forward slashes only.');
  }
  if (normalized.includes('..') || normalized.includes('./') || normalized.includes('/.')) {
    throw new Error('Path traversal not allowed');
  }
  const depth = normalized.split('/').length;
  if (depth > SECURITY_LIMITS.MAX_PATH_DEPTH) {
    throw new Error(`Path too deep (max ${SECURITY_LIMITS.MAX_PATH_DEPTH} levels)`);
  }
  if (baseDir) {
    const resolvedPath = path.resolve(baseDir, normalized);
    const resolvedBase = path.resolve(baseDir);
    if (!resolvedPath.startsWith(resolvedBase)) {
      throw new Error('Path traversal attempt detected');
    }
  }
  return normalized;
}

export function validateUsername(username: string): string {
  if (!username || typeof username !== 'string') {
    throw new Error('Username must be a non-empty string');
  }
  if (!VALIDATION_PATTERNS.SAFE_USERNAME.test(username)) {
    throw new Error('Invalid username format. Use alphanumeric characters, hyphens, underscores, and dots only.');
  }
  return username.toLowerCase();
}

export function validateCategory(category: string): string {
  if (!category || typeof category !== 'string') {
    throw new Error('Category must be a non-empty string');
  }
  if (!VALIDATION_PATTERNS.SAFE_CATEGORY.test(category)) {
    throw new Error('Invalid category format. Must start with a letter, followed by letters, digits, hyphens, or underscores (max 21 chars).');
  }
  return category.toLowerCase();
}

export function validateContentSize(content: string, maxSize: number = SECURITY_LIMITS.MAX_CONTENT_LENGTH): void {
  if (!content || typeof content !== 'string') {
    throw new Error('Content must be a non-empty string');
  }
  const sizeBytes = Buffer.byteLength(content, 'utf8');
  if (sizeBytes > maxSize) {
    throw new Error(`Content too large (${sizeBytes} bytes, max ${maxSize} bytes)`);
  }
}

export function sanitizeInput(input: string, maxLength: number = 1000): string {
  if (!input || typeof input !== 'string') return '';
  return input
    .replaceAll(CONTROL_CHARS_REGEX, '')
    .replaceAll(HTML_DANGEROUS_REGEX, '')
    .replaceAll(SHELL_METACHAR_REGEX, '')
    .replaceAll(RTL_ZEROWIDTH_REGEX, '')
    .substring(0, maxLength)
    .trim();
}
