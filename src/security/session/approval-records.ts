/**
 * Approval Session Management
 *
 * Manages per-connection session state for approval tracking.
 * Each client connection gets a separate session with isolated state.
 *
 * Session state is IN-MEMORY only:
 * - Confirmations are NOT persisted to disk
 * - No cross-session policy leakage
 * - Crash = fresh session (security-first decision)
 *
 * Ported from DollhouseMCP/mcp-server-v2-refactor src/handlers/mcp-aql/GatekeeperSession.ts
 * Zero DollhouseMCP imports.
 *
 * @module
 */

import { randomUUID } from 'crypto';
import type {
  ConfirmationRecord,
  PermissionLevel,
  CliApprovalRecord,
  CliApprovalScope,
  ClientInfo,
  ApprovalSessionState,
} from '../types.js';

/** Default maximum number of CLI approval records before LRU eviction */
const DEFAULT_MAX_CLI_APPROVALS = 100;

/** Default TTL for CLI approval records (5 minutes) */
const DEFAULT_APPROVAL_TTL_MS = 300_000;

/** Minimum TTL for CLI approval records (1 second) */
const MIN_APPROVAL_TTL_MS = 1_000;

/** Maximum TTL for CLI approval records (24 hours) */
const MAX_APPROVAL_TTL_MS = 86_400_000;

/** Throttle interval for expiry sweeps (10 seconds) */
const EXPIRY_SWEEP_INTERVAL_MS = 10_000;

export class ApprovalSession {
  private readonly state: ApprovalSessionState;
  private readonly maxConfirmations: number;
  private readonly maxCliApprovals: number;
  private lastExpirySweep = 0;

  constructor(clientInfo?: ClientInfo, maxConfirmations: number = 100, maxCliApprovals: number = DEFAULT_MAX_CLI_APPROVALS) {
    this.maxConfirmations = maxConfirmations;
    this.maxCliApprovals = maxCliApprovals;
    this.state = {
      sessionId: randomUUID(),
      clientInfo,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      confirmations: new Map(),
      cliApprovals: new Map(),
      cliSessionApprovals: new Map(),
      permissionPromptActive: false,
    };
  }

  get sessionId(): string {
    return this.state.sessionId;
  }

  get clientInfo(): ClientInfo | undefined {
    return this.state.clientInfo;
  }

  get createdAt(): string {
    return this.state.createdAt;
  }

  get lastActivity(): string {
    return this.state.lastActivity;
  }

  get isPermissionPromptActive(): boolean {
    return this.state.permissionPromptActive;
  }

  markPermissionPromptActive(): void {
    this.state.permissionPromptActive = true;
  }

  touch(): void {
    this.state.lastActivity = new Date().toISOString();
  }

  /**
   * Record a confirmation for an operation.
   */
  recordConfirmation(
    operation: string,
    permissionLevel: PermissionLevel,
    elementType?: string
  ): void {
    this.touch();

    // Enforce max confirmations (LRU eviction)
    if (this.state.confirmations.size >= this.maxConfirmations) {
      const oldestKey = this.state.confirmations.keys().next().value;
      if (oldestKey) {
        this.state.confirmations.delete(oldestKey);
      }
    }

    const key = this.getConfirmationKey(operation, elementType);
    this.state.confirmations.set(key, {
      operation,
      confirmedAt: new Date().toISOString(),
      permissionLevel,
      useCount: 0,
      elementType,
    });
  }

  /**
   * Check if an operation has a valid session confirmation.
   * For CONFIRM_SINGLE_USE, this invalidates the confirmation after checking.
   */
  checkConfirmation(operation: string, elementType?: string): ConfirmationRecord | undefined {
    this.touch();

    const key = this.getConfirmationKey(operation, elementType);
    let confirmation = this.state.confirmations.get(key);

    // Fall back to unscoped confirmation
    if (!confirmation && elementType) {
      confirmation = this.state.confirmations.get(operation);
    }

    if (!confirmation) {
      return undefined;
    }

    confirmation.useCount++;

    if (confirmation.permissionLevel === 'CONFIRM_SINGLE_USE') {
      if (this.state.confirmations.has(key)) {
        this.state.confirmations.delete(key);
      } else {
        this.state.confirmations.delete(operation);
      }
    }

    return confirmation;
  }

  /**
   * Check confirmation WITHOUT consuming it.
   */
  peekConfirmation(operation: string, elementType?: string): ConfirmationRecord | undefined {
    const key = this.getConfirmationKey(operation, elementType);
    return this.state.confirmations.get(key);
  }

  revokeConfirmation(operation: string, elementType?: string): boolean {
    this.touch();
    const key = this.getConfirmationKey(operation, elementType);
    return this.state.confirmations.delete(key);
  }

  revokeAllConfirmations(): void {
    this.touch();
    this.state.confirmations.clear();
  }

  getActiveConfirmations(): ConfirmationRecord[] {
    return Array.from(this.state.confirmations.values());
  }

  // ── CLI Approval Store ────────────────────────────────────────

  createCliApprovalRequest(
    toolName: string,
    toolInput: Record<string, unknown>,
    riskLevel: string,
    riskScore: number,
    irreversible: boolean,
    denyReason: string,
    policySource?: string,
    ttlMs?: number,
  ): string {
    this.touch();
    this.expireStaleApprovals(true);

    // LRU eviction at max capacity
    if (this.state.cliApprovals.size >= this.maxCliApprovals) {
      const oldestKey = this.state.cliApprovals.keys().next().value;
      if (oldestKey) {
        this.state.cliApprovals.delete(oldestKey);
      }
    }

    const requestId = `cli-${randomUUID()}`;
    const clampedTtl = ttlMs != null
      ? Math.max(MIN_APPROVAL_TTL_MS, Math.min(MAX_APPROVAL_TTL_MS, ttlMs))
      : undefined;
    const record: CliApprovalRecord = {
      requestId,
      toolName,
      toolInput,
      riskLevel,
      riskScore,
      irreversible,
      requestedAt: new Date().toISOString(),
      consumed: false,
      scope: 'single',
      denyReason,
      policySource,
      ttlMs: clampedTtl,
    };
    this.state.cliApprovals.set(requestId, record);
    return requestId;
  }

  approveCliRequest(requestId: string, scope: CliApprovalScope = 'single'): CliApprovalRecord | undefined {
    this.touch();
    const record = this.state.cliApprovals.get(requestId);
    if (!record || record.approvedAt) {
      return undefined;
    }

    record.approvedAt = new Date().toISOString();
    record.scope = scope;

    if (scope === 'tool_session') {
      this.state.cliSessionApprovals.set(record.toolName, record);
    }

    return record;
  }

  checkCliApproval(toolName: string, _toolInput: Record<string, unknown>): CliApprovalRecord | undefined {
    this.touch();
    this.expireStaleApprovals();

    const sessionApproval = this.state.cliSessionApprovals.get(toolName);
    if (sessionApproval) {
      return sessionApproval;
    }

    for (const [, record] of this.state.cliApprovals) {
      if (record.toolName === toolName && record.approvedAt && !record.consumed) {
        if (record.scope === 'single') {
          record.consumed = true;
        }
        return record;
      }
    }

    return undefined;
  }

  getPendingCliApprovals(): CliApprovalRecord[] {
    this.expireStaleApprovals(true);
    const pending: CliApprovalRecord[] = [];
    for (const [, record] of this.state.cliApprovals) {
      if (!record.approvedAt) {
        pending.push(record);
      }
    }
    return pending;
  }

  private expireStaleApprovals(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastExpirySweep < EXPIRY_SWEEP_INTERVAL_MS) return;
    this.lastExpirySweep = now;

    for (const [key, record] of this.state.cliApprovals) {
      const ttl = record.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
      const age = now - new Date(record.requestedAt).getTime();
      if (age > ttl && !record.approvedAt) {
        this.state.cliApprovals.delete(key);
      }
    }
  }

  getSummary(): {
    sessionId: string;
    clientInfo?: ClientInfo;
    createdAt: string;
    lastActivity: string;
    confirmationCount: number;
    cliApprovalCount: number;
    permissionPromptActive: boolean;
  } {
    return {
      sessionId: this.state.sessionId,
      clientInfo: this.state.clientInfo,
      createdAt: this.state.createdAt,
      lastActivity: this.state.lastActivity,
      confirmationCount: this.state.confirmations.size,
      cliApprovalCount: this.state.cliApprovals.size,
      permissionPromptActive: this.state.permissionPromptActive,
    };
  }

  private getConfirmationKey(operation: string, elementType?: string): string {
    return elementType ? `${operation}:${elementType}` : operation;
  }
}
