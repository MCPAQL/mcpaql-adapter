/**
 * Shared types for @mcpaql/security
 *
 * All types needed across the security package are defined here,
 * eliminating any dependency on DollhouseMCP modules.
 *
 * @module
 */

// ── Risk & Classification ──────────────────────────────────────────

export type ToolRiskLevel = 'safe' | 'moderate' | 'dangerous' | 'blocked';

export type SecuritySeverity = 'low' | 'medium' | 'high' | 'critical';

export interface ToolClassificationResult {
  riskLevel: ToolRiskLevel;
  /** 'allow' = auto-approve, 'deny' = auto-reject, 'evaluate' = check element policies */
  behavior: 'allow' | 'deny' | 'evaluate';
  reason: string;
}

export interface RiskAssessment {
  score: number;
  irreversible: boolean;
  factors: string[];
}

export interface PolicyEvaluationContext {
  evaluatedElements: Array<{
    type: string;
    name: string;
    matched?: 'allowPatterns' | 'denyPatterns';
    matchedPattern?: string;
    matchedTarget?: string;
  }>;
  decisionChain: string[];
}

export interface CliToolPolicyResult {
  behavior: 'allow' | 'deny' | 'evaluate';
  message?: string;
  policyContext?: PolicyEvaluationContext;
}

// ── Active Element (simplified for policy evaluation) ──────────────

export interface ActiveElement {
  type: string;
  name: string;
  metadata?: {
    name?: string;
    gatekeeper?: {
      externalRestrictions?: {
        description?: string;
        denyPatterns?: string[];
        allowPatterns?: string[];
      };
    };
    [key: string]: unknown;
  };
}

// ── Content Validation ─────────────────────────────────────────────

export interface ContentValidationResult {
  isValid: boolean;
  sanitizedContent?: string;
  detectedPatterns?: string[];
  severity?: SecuritySeverity;
}

export interface ContentValidatorOptions {
  /** Skip size limit checks - useful for memory content that can be large */
  skipSizeCheck?: boolean;
  /** Custom max length override (default: 50000) */
  maxLength?: number;
  /** Element type context for context-aware pattern matching */
  contentContext?: 'persona' | 'skill' | 'template' | 'agent' | 'memory';
}

// ── Unicode Validation ─────────────────────────────────────────────

export interface UnicodeValidationResult {
  isValid: boolean;
  normalizedContent: string;
  detectedIssues?: string[];
  severity?: SecuritySeverity;
}

// ── Input Normalization ────────────────────────────────────────────

export interface NormalizationResult<T = unknown> {
  /** The normalized data structure with all strings normalized */
  data: T;
  /** Whether normalization detected any issues */
  hasIssues: boolean;
  /** Whether critical-severity issues were detected that should fail validation */
  hasCriticalIssues: boolean;
  /** Whether high or critical severity issues were detected */
  hasHighOrCriticalIssues: boolean;
  /** All errors detected during normalization (critical issues) */
  errors: string[];
  /** All warnings detected during normalization (non-critical issues) */
  warnings: string[];
  /** Detailed issues by path (for debugging) */
  issuesByPath: Map<string, string[]>;
  /** Highest severity level detected */
  maxSeverity?: SecuritySeverity;
}

// ── Rate Limiter ───────────────────────────────────────────────────

export interface RateLimiterConfig {
  maxRequests: number;
  windowMs: number;
  minDelayMs?: number;
}

export interface RateLimitStatus {
  allowed: boolean;
  retryAfterMs?: number;
  remainingTokens: number;
  resetTime: Date;
}

// ── Session / Approval Records ─────────────────────────────────────

export type PermissionLevel = 'CONFIRM_SESSION' | 'CONFIRM_SINGLE_USE';

export type CliApprovalScope = 'single' | 'tool_session';

export interface ConfirmationRecord {
  operation: string;
  confirmedAt: string;
  permissionLevel: PermissionLevel;
  useCount: number;
  elementType?: string;
}

export interface CliApprovalRecord {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  riskLevel: string;
  riskScore: number;
  irreversible: boolean;
  requestedAt: string;
  approvedAt?: string;
  consumed: boolean;
  scope: CliApprovalScope;
  denyReason: string;
  policySource?: string;
  ttlMs?: number;
}

export interface ClientInfo {
  name: string;
  version: string;
}

export interface ApprovalSessionState {
  sessionId: string;
  clientInfo?: ClientInfo;
  createdAt: string;
  lastActivity: string;
  confirmations: Map<string, ConfirmationRecord>;
  cliApprovals: Map<string, CliApprovalRecord>;
  cliSessionApprovals: Map<string, CliApprovalRecord>;
  permissionPromptActive: boolean;
}
