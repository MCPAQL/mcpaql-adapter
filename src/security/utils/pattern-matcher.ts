/**
 * Pattern Matching Utilities
 *
 * Provides glob-like pattern matching for tool filtering,
 * autonomy configuration, and other pattern-based matching needs.
 *
 * Supports:
 * - * matches any sequence of characters
 * - ? matches any single character
 *
 * Ported from DollhouseMCP/mcp-server-v2-refactor src/utils/patternMatcher.ts
 * Zero DollhouseMCP imports.
 *
 * @module
 */

/** Maximum allowed glob pattern length to prevent ReDoS */
export const MAX_GLOB_PATTERN_LENGTH = 500;

/** Maximum allowed text length for pattern matching */
export const MAX_PATTERN_MATCH_TEXT_LENGTH = 10_000;

/** LRU cache for compiled glob->regex conversions */
const REGEX_CACHE_MAX = 256;
const regexCache = new Map<string, RegExp>();

/**
 * Convert a glob pattern to a RegExp (cached).
 *
 * Compiled regexes are cached in an LRU map (max 256 entries) to avoid
 * recompilation on repeated pattern matching calls.
 *
 * @param pattern - Glob pattern with * and ? wildcards
 * @returns RegExp that matches the pattern (never-matching if pattern exceeds length limit)
 */
export function globToRegex(pattern: string): RegExp {
  if (pattern.length > MAX_GLOB_PATTERN_LENGTH) {
    console.warn(
      `Glob pattern exceeds maximum length (${pattern.length} > ${MAX_GLOB_PATTERN_LENGTH}), returning never-matching regex`
    );
    return /(?!)/;
  }

  const cached = regexCache.get(pattern);
  if (cached) return cached;

  const patternLower = pattern.toLowerCase();

  // Convert glob pattern to regex
  const regexPattern = patternLower
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special regex chars
    .replace(/\*/g, '.*') // * becomes .*
    .replace(/\?/g, '.'); // ? becomes .

  const compiled = new RegExp(`^${regexPattern}$`, 'i');

  // LRU eviction: drop oldest entry when at capacity
  if (regexCache.size >= REGEX_CACHE_MAX) {
    const oldestKey = regexCache.keys().next().value;
    if (oldestKey) regexCache.delete(oldestKey);
  }
  regexCache.set(pattern, compiled);

  return compiled;
}

/**
 * Check if text matches a glob-like pattern.
 *
 * Uses a non-backtracking dynamic-programming algorithm when the
 * pattern contains multiple `*` wildcards (which produce `.*` runs
 * that cause catastrophic backtracking in regex engines).  Falls
 * back to the cached regex path for simple patterns (0 or 1 star).
 *
 * @param text - The text to match against
 * @param pattern - Glob pattern with * and ? wildcards
 * @returns true if text matches the pattern
 */
export function matchesPattern(text: string, pattern: string): boolean {
  if (text.length > MAX_PATTERN_MATCH_TEXT_LENGTH) {
    console.warn(
      `Text exceeds maximum length for pattern matching (${text.length} > ${MAX_PATTERN_MATCH_TEXT_LENGTH}), returning false`
    );
    return false;
  }

  if (pattern.length > MAX_GLOB_PATTERN_LENGTH) {
    return false;
  }

  // Count stars — if multiple, use the DP matcher to avoid ReDoS
  const starCount = countChar(pattern, '*');
  if (starCount >= 2) {
    return globMatchDP(text.toLowerCase(), pattern.toLowerCase());
  }

  const regex = globToRegex(pattern);
  return regex.test(text);
}

/** Count occurrences of a character in a string */
function countChar(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ch) n++;
  }
  return n;
}

/**
 * O(n*m) dynamic-programming glob matcher — immune to ReDoS.
 *
 * Supports `*` (match any sequence) and `?` (match single char).
 * All other characters are matched literally (case already lowered by caller).
 */
function globMatchDP(text: string, pattern: string): boolean {
  const n = text.length;
  const m = pattern.length;

  // dp[j] = true means pattern[0..j-1] matches text[0..i-1]
  // We use a 1-D array and update in-place for each text character.
  const dp = new Array<boolean>(m + 1).fill(false);
  dp[0] = true;

  // Initial pass: leading *'s match empty text
  for (let j = 1; j <= m; j++) {
    if (pattern[j - 1] === '*') {
      dp[j] = dp[j - 1];
    } else {
      break;
    }
  }

  for (let i = 1; i <= n; i++) {
    const prev = dp.slice(); // dp values for text[0..i-2]
    dp[0] = false; // empty pattern cannot match non-empty text

    for (let j = 1; j <= m; j++) {
      const pc = pattern[j - 1];
      if (pc === '*') {
        // * matches zero chars (prev[j]) or one more char (dp[j-1])
        dp[j] = prev[j] || dp[j - 1];
      } else if (pc === '?' || pc === text[i - 1]) {
        dp[j] = prev[j - 1];
      } else {
        dp[j] = false;
      }
    }
  }

  return dp[m];
}

/**
 * Check if two patterns could potentially conflict
 *
 * Two patterns conflict if:
 * 1. They are identical (exact match)
 * 2. One pattern could match strings that the other pattern would also match
 *
 * @param patternA - First pattern
 * @param patternB - Second pattern
 * @returns Object with conflict status and details
 */
export function detectPatternConflict(
  patternA: string,
  patternB: string
): { conflicts: boolean; reason?: string } {
  // Exact match is always a conflict
  if (patternA.toLowerCase() === patternB.toLowerCase()) {
    return { conflicts: true, reason: 'exact match' };
  }

  // Check if patternB matches patternA (B is more specific than A)
  if (matchesPattern(patternB, patternA)) {
    return {
      conflicts: true,
      reason: `'${patternB}' matches pattern '${patternA}'`,
    };
  }

  // Check if patternA matches patternB (A is more specific than B)
  if (matchesPattern(patternA, patternB)) {
    return {
      conflicts: true,
      reason: `'${patternA}' matches pattern '${patternB}'`,
    };
  }

  return { conflicts: false };
}

/**
 * Find all conflicts between two sets of patterns
 *
 * @param patternsA - First set of patterns
 * @param patternsB - Second set of patterns
 * @returns Array of conflict descriptions
 */
export function findPatternConflicts(
  patternsA: string[],
  patternsB: string[]
): string[] {
  const conflicts: string[] = [];

  for (const patternA of patternsA) {
    for (const patternB of patternsB) {
      const result = detectPatternConflict(patternA, patternB);
      if (result.conflicts) {
        conflicts.push(
          `Conflict between '${patternA}' and '${patternB}': ${result.reason}`
        );
      }
    }
  }

  return conflicts;
}
