/**
 * Rate Limiter Tests
 *
 * Tests token bucket rate limiting, minimum delay enforcement,
 * factory methods, and edge cases.
 *
 * Ported from DollhouseMCP/mcp-server-v2-refactor (no dedicated test file existed;
 * assertions derived from the security test and implementation contract).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter, RateLimiterFactory } from '../../src/security/utils/rate-limiter.js';

describe('RateLimiter', () => {
  describe('constructor', () => {
    it('should throw for non-positive maxRequests', () => {
      assert.throws(() => new RateLimiter({ maxRequests: 0, windowMs: 1000 }), /maxRequests must be positive/);
      assert.throws(() => new RateLimiter({ maxRequests: -1, windowMs: 1000 }), /maxRequests must be positive/);
    });

    it('should throw for non-positive windowMs', () => {
      assert.throws(() => new RateLimiter({ maxRequests: 10, windowMs: 0 }), /windowMs must be positive/);
      assert.throws(() => new RateLimiter({ maxRequests: 10, windowMs: -100 }), /windowMs must be positive/);
    });

    it('should create with valid config', () => {
      const limiter = new RateLimiter({ maxRequests: 10, windowMs: 60000 });
      assert.ok(limiter);
    });
  });

  describe('checkLimit', () => {
    it('should allow requests within limit', () => {
      const limiter = new RateLimiter({ maxRequests: 5, windowMs: 60000 });
      const status = limiter.checkLimit();
      assert.equal(status.allowed, true);
      assert.equal(status.remainingTokens, 5);
    });

    it('should deny after tokens exhausted', () => {
      const limiter = new RateLimiter({ maxRequests: 2, windowMs: 60000 });
      limiter.consumeToken();
      limiter.consumeToken();
      const status = limiter.checkLimit();
      assert.equal(status.allowed, false);
      assert.ok(status.retryAfterMs! > 0);
    });

    it('should enforce minimum delay', () => {
      const limiter = new RateLimiter({ maxRequests: 100, windowMs: 60000, minDelayMs: 5000 });
      limiter.consumeToken();
      const status = limiter.checkLimit();
      assert.equal(status.allowed, false);
      assert.ok(status.retryAfterMs! > 0);
    });
  });

  describe('consumeToken', () => {
    it('should reduce remaining tokens', () => {
      const limiter = new RateLimiter({ maxRequests: 5, windowMs: 60000 });
      limiter.consumeToken();
      const status = limiter.getStatus();
      assert.equal(status.remainingTokens, 4);
    });
  });

  describe('reset', () => {
    it('should restore full capacity', () => {
      const limiter = new RateLimiter({ maxRequests: 5, windowMs: 60000 });
      limiter.consumeToken();
      limiter.consumeToken();
      limiter.reset();
      const status = limiter.getStatus();
      assert.equal(status.remainingTokens, 5);
    });
  });

  describe('toString', () => {
    it('should return human-readable string', () => {
      const limiter = new RateLimiter({ maxRequests: 10, windowMs: 60000 });
      const str = limiter.toString();
      assert.ok(str.includes('RateLimit'));
      assert.ok(str.includes('10'));
    });
  });
});

describe('RateLimiterFactory', () => {
  it('should create GitHub limiter', () => {
    const limiter = RateLimiterFactory.createGitHubLimiter();
    assert.ok(limiter);
    const status = limiter.checkLimit();
    assert.equal(status.allowed, true);
    assert.equal(status.remainingTokens, 60);
  });

  it('should create update check limiter', () => {
    const limiter = RateLimiterFactory.createUpdateCheckLimiter();
    assert.ok(limiter);
    assert.equal(limiter.getStatus().remainingTokens, 10);
  });

  it('should create strict limiter', () => {
    const limiter = RateLimiterFactory.createStrictLimiter();
    assert.ok(limiter);
    assert.equal(limiter.getStatus().remainingTokens, 5);
  });

  it('should create permission prompt limiter with defaults', () => {
    const limiter = RateLimiterFactory.createPermissionPromptLimiter();
    assert.ok(limiter);
    assert.equal(limiter.getStatus().remainingTokens, 100);
  });

  it('should create CLI approval limiter with custom params', () => {
    const limiter = RateLimiterFactory.createCliApprovalLimiter(50, 30000);
    assert.ok(limiter);
    assert.equal(limiter.getStatus().remainingTokens, 50);
  });
});
