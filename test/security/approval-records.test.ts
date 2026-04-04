/**
 * Approval Records (Session) Tests
 *
 * Tests per-connection approval session state management,
 * CLI approval store, and confirmation tracking.
 *
 * Ported from DollhouseMCP/mcp-server-v2-refactor tests/unit/handlers/mcp-aql/GatekeeperSession.cliApprovals.test.ts
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalSession } from '../../src/security/session/approval-records.js';

describe('ApprovalSession', () => {
  let session: ApprovalSession;

  beforeEach(() => {
    session = new ApprovalSession(undefined, 100, 50);
  });

  describe('basic session properties', () => {
    it('should have a valid UUID session id', () => {
      assert.match(session.sessionId, /^[0-9a-f-]{36}$/);
    });

    it('should have creation and activity timestamps', () => {
      assert.ok(session.createdAt);
      assert.ok(session.lastActivity);
    });

    it('should default permissionPromptActive to false', () => {
      assert.equal(session.isPermissionPromptActive, false);
      assert.equal(session.getSummary().permissionPromptActive, false);
    });

    it('should set permissionPromptActive after markPermissionPromptActive()', () => {
      session.markPermissionPromptActive();
      assert.equal(session.isPermissionPromptActive, true);
      assert.equal(session.getSummary().permissionPromptActive, true);
    });
  });

  describe('confirmations', () => {
    it('should record and check session confirmation', () => {
      session.recordConfirmation('create_element', 'CONFIRM_SESSION');
      const confirmation = session.checkConfirmation('create_element');
      assert.ok(confirmation);
      assert.equal(confirmation!.operation, 'create_element');
      assert.equal(confirmation!.useCount, 1);
    });

    it('should consume single-use confirmations', () => {
      session.recordConfirmation('delete_element', 'CONFIRM_SINGLE_USE');
      const first = session.checkConfirmation('delete_element');
      assert.ok(first);
      const second = session.checkConfirmation('delete_element');
      assert.equal(second, undefined);
    });

    it('should support element-type scoped confirmations', () => {
      session.recordConfirmation('create_element', 'CONFIRM_SESSION', 'skill');
      const scoped = session.checkConfirmation('create_element', 'skill');
      assert.ok(scoped);
    });

    it('should fall back to unscoped confirmation', () => {
      session.recordConfirmation('create_element', 'CONFIRM_SESSION');
      const result = session.checkConfirmation('create_element', 'skill');
      assert.ok(result);
    });

    it('should revoke confirmations', () => {
      session.recordConfirmation('create_element', 'CONFIRM_SESSION');
      assert.equal(session.revokeConfirmation('create_element'), true);
      assert.equal(session.checkConfirmation('create_element'), undefined);
    });

    it('should revoke all confirmations', () => {
      session.recordConfirmation('create_element', 'CONFIRM_SESSION');
      session.recordConfirmation('delete_element', 'CONFIRM_SESSION');
      session.revokeAllConfirmations();
      assert.equal(session.getActiveConfirmations().length, 0);
    });

    it('should peek without consuming', () => {
      session.recordConfirmation('create_element', 'CONFIRM_SINGLE_USE');
      const peeked = session.peekConfirmation('create_element');
      assert.ok(peeked);
      // Still available after peek
      const check = session.checkConfirmation('create_element');
      assert.ok(check);
    });
  });

  describe('createCliApprovalRequest', () => {
    it('should create a request with cli- prefixed UUID', () => {
      const requestId = session.createCliApprovalRequest(
        'Bash', { command: 'npm install' }, 'dangerous', 80, false, 'dangerous command'
      );
      assert.match(requestId, /^cli-[0-9a-f-]{36}$/);
    });

    it('should store the request as pending', () => {
      session.createCliApprovalRequest(
        'Bash', { command: 'npm install' }, 'dangerous', 80, false, 'dangerous command'
      );
      const pending = session.getPendingCliApprovals();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].toolName, 'Bash');
      assert.equal(pending[0].approvedAt, undefined);
    });

    it('should evict oldest when at max capacity', () => {
      const smallSession = new ApprovalSession(undefined, 100, 3);
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        ids.push(smallSession.createCliApprovalRequest(
          `Tool${i}`, {}, 'moderate', 40, false, 'test'
        ));
      }
      const pending = smallSession.getPendingCliApprovals();
      assert.equal(pending.length, 3);
      assert.equal(pending.find(p => p.requestId === ids[0]), undefined);
    });
  });

  describe('approveCliRequest', () => {
    it('should set approvedAt on approval', () => {
      const requestId = session.createCliApprovalRequest(
        'Bash', { command: 'npm install' }, 'dangerous', 80, false, 'test'
      );
      const record = session.approveCliRequest(requestId, 'single');
      assert.ok(record);
      assert.ok(record!.approvedAt);
    });

    it('should return undefined for nonexistent request', () => {
      const record = session.approveCliRequest('cli-nonexistent', 'single');
      assert.equal(record, undefined);
    });

    it('should return undefined for already approved request', () => {
      const requestId = session.createCliApprovalRequest(
        'Bash', { command: 'npm install' }, 'dangerous', 80, false, 'test'
      );
      session.approveCliRequest(requestId, 'single');
      const secondApproval = session.approveCliRequest(requestId, 'single');
      assert.equal(secondApproval, undefined);
    });

    it('should promote to session approvals for tool_session scope', () => {
      const requestId = session.createCliApprovalRequest(
        'Bash', { command: 'npm install' }, 'dangerous', 80, false, 'test'
      );
      session.approveCliRequest(requestId, 'tool_session');

      const found = session.checkCliApproval('Bash', { command: 'different command' });
      assert.ok(found);
      assert.equal(found!.scope, 'tool_session');
    });
  });

  describe('checkCliApproval', () => {
    it('should return and consume single-scope approvals', () => {
      const requestId = session.createCliApprovalRequest(
        'Bash', { command: 'npm install' }, 'dangerous', 80, false, 'test'
      );
      session.approveCliRequest(requestId, 'single');

      const first = session.checkCliApproval('Bash', { command: 'npm install' });
      assert.ok(first);
      assert.equal(first!.consumed, true);

      const second = session.checkCliApproval('Bash', { command: 'npm install' });
      assert.equal(second, undefined);
    });

    it('should return but preserve tool_session-scope approvals', () => {
      const requestId = session.createCliApprovalRequest(
        'Bash', { command: 'npm install' }, 'dangerous', 80, false, 'test'
      );
      session.approveCliRequest(requestId, 'tool_session');

      const first = session.checkCliApproval('Bash', { command: 'npm install' });
      assert.ok(first);
      const second = session.checkCliApproval('Bash', { command: 'git push --force' });
      assert.ok(second);
      const third = session.checkCliApproval('Bash', {});
      assert.ok(third);
    });

    it('should return undefined for unapproved requests', () => {
      session.createCliApprovalRequest(
        'Bash', { command: 'npm install' }, 'dangerous', 80, false, 'test'
      );
      const result = session.checkCliApproval('Bash', { command: 'npm install' });
      assert.equal(result, undefined);
    });

    it('should not match different tool names', () => {
      const requestId = session.createCliApprovalRequest(
        'Bash', { command: 'npm install' }, 'dangerous', 80, false, 'test'
      );
      session.approveCliRequest(requestId, 'single');

      const result = session.checkCliApproval('Edit', { file_path: 'foo.ts' });
      assert.equal(result, undefined);
    });
  });

  describe('getPendingCliApprovals', () => {
    it('should return only unapproved records', () => {
      const id1 = session.createCliApprovalRequest('Bash', {}, 'dangerous', 80, false, 'test');
      session.createCliApprovalRequest('Edit', {}, 'moderate', 40, false, 'test');
      session.approveCliRequest(id1, 'single');

      const pending = session.getPendingCliApprovals();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].toolName, 'Edit');
    });

    it('should return empty array when no pending', () => {
      assert.equal(session.getPendingCliApprovals().length, 0);
    });
  });

  describe('expiry', () => {
    it('should expire stale unapproved requests', () => {
      session.createCliApprovalRequest(
        'Bash', { command: 'npm install' }, 'dangerous', 80, false, 'test'
      );

      const pending = session.getPendingCliApprovals();
      assert.equal(pending.length, 1);

      // Backdate to 10 minutes ago (past default 5 min TTL)
      (pending[0] as any).requestedAt = new Date(Date.now() - 600_000).toISOString();

      // Trigger lazy expiry by creating a new request
      session.createCliApprovalRequest('Edit', {}, 'moderate', 40, false, 'test');

      const remaining = session.getPendingCliApprovals();
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].toolName, 'Edit');
    });

    it('should use per-record ttlMs when set', () => {
      session.createCliApprovalRequest(
        'Bash', { command: 'npm install' }, 'dangerous', 80, false, 'test', undefined, 60_000
      );

      const pending = session.getPendingCliApprovals();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].ttlMs, 60_000);

      // Backdate to 70s ago (past 60s TTL, but within default 300s)
      (pending[0] as any).requestedAt = new Date(Date.now() - 70_000).toISOString();

      session.createCliApprovalRequest('Edit', {}, 'moderate', 40, false, 'test');

      const remaining = session.getPendingCliApprovals();
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].toolName, 'Edit');
    });
  });

  describe('summary', () => {
    it('should include cliApprovalCount in summary', () => {
      session.createCliApprovalRequest('Bash', {}, 'dangerous', 80, false, 'test');
      session.createCliApprovalRequest('Edit', {}, 'moderate', 40, false, 'test');

      const summary = session.getSummary();
      assert.equal(summary.cliApprovalCount, 2);
    });
  });
});
