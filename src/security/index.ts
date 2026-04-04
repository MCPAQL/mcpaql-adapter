/**
 * @mcpaql/security — Standalone security package
 *
 * Ported from DollhouseMCP/mcp-server-v2-refactor with zero
 * framework dependencies. All pattern lists, homoglyph mappings,
 * and injection detection rules are preserved exactly.
 *
 * @module
 */

// ── Types ──────────────────────────────────────────────────────────
export type {
  ToolRiskLevel,
  SecuritySeverity,
  ToolClassificationResult,
  RiskAssessment,
  PolicyEvaluationContext,
  CliToolPolicyResult,
  ActiveElement,
  ContentValidationResult,
  ContentValidatorOptions,
  UnicodeValidationResult,
  NormalizationResult,
  RateLimiterConfig,
  RateLimitStatus,
  PermissionLevel,
  CliApprovalScope,
  ConfirmationRecord,
  CliApprovalRecord,
  ClientInfo,
  ApprovalSessionState,
} from './types.js';

// ── Classification ─────────────────────────────────────────────────
export {
  classifyTool,
  assessRisk,
  evaluateCliToolPolicy,
  getStaticPolicyData,
} from './classification/tool-classification.js';

// ── Validators ─────────────────────────────────────────────────────
export { ContentValidator } from './validators/content-validator.js';
export { UnicodeValidator } from './validators/unicode-validator.js';

// ── Sanitizers ─────────────────────────────────────────────────────
export { InputNormalizer } from './sanitizers/input-normalizer.js';
export {
  MCPInputValidator,
  validateFilename,
  validatePath,
  validateUsername,
  validateCategory,
  validateContentSize,
  sanitizeInput,
} from './sanitizers/input-validator.js';

// ── Utils ──────────────────────────────────────────────────────────
export {
  matchesPattern,
  globToRegex,
  detectPatternConflict,
  findPatternConflicts,
  MAX_GLOB_PATTERN_LENGTH,
  MAX_PATTERN_MATCH_TEXT_LENGTH,
} from './utils/pattern-matcher.js';
export { RateLimiter, RateLimiterFactory } from './utils/rate-limiter.js';

// ── Session ────────────────────────────────────────────────────────
export { ApprovalSession } from './session/approval-records.js';
