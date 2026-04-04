/**
 * Tool Classification for CLI-Level Permission Prompts
 *
 * Provides static classification of CLI tool calls and
 * evaluation against active element policies.
 *
 * Ported from DollhouseMCP/mcp-server-v2-refactor src/handlers/mcp-aql/policies/ToolClassification.ts
 * Zero DollhouseMCP imports.
 *
 * @module
 */

import { matchesPattern } from '../utils/pattern-matcher.js';
import type {
  ToolClassificationResult,
  RiskAssessment,
  CliToolPolicyResult,
  PolicyEvaluationContext,
  ActiveElement,
} from '../types.js';

// ── Gatekeeper-Essential Operations ──────────────────────────────────

/**
 * MCP-AQL operations that must NEVER be blocked by permission_prompt.
 */
const GATEKEEPER_ESSENTIAL_OPERATIONS = new Set([
  'confirm_operation',
  'verify_challenge',
  'permission_prompt',
  'introspect',
  'get_active_elements',
  'get_execution_state',
  'get_gathered_data',
  'approve_cli_permission',
  'get_pending_cli_approvals',
]);

/**
 * MCP-AQL operations that are inherently read-only.
 */
const SAFE_MCP_OPERATIONS = new Set([
  'list_elements', 'get_element', 'get_element_details',
  'search_elements', 'query_elements', 'get_active_elements',
  'validate_element', 'render', 'export_element', 'introspect',
  'get_execution_state', 'get_gathered_data',
  'browse_collection', 'search_collection', 'search_collection_enhanced',
  'get_collection_content', 'get_collection_cache_health',
  'portfolio_status', 'portfolio_config', 'search_portfolio',
  'search_all', 'check_github_auth', 'oauth_helper_status',
  'dollhouse_config', 'get_build_info', 'get_cache_budget_report',
  'query_logs', 'find_similar_elements', 'get_element_relationships',
  'search_by_verb', 'get_relationship_stats',
  'get_effective_cli_policies', 'get_pending_cli_approvals',
]);

// ── Static Classification Lists ────────────────────────────────────

const SAFE_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch',
  'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskOutput',
  'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode',
  'TodoRead', 'TodoWrite',
]);

const SAFE_BASH_PATTERNS = [
  'git status*', 'git log*', 'git diff*', 'git branch*', 'git show*',
  'git remote*', 'git stash list*',
  'ls*', 'pwd', 'cat *', 'head *', 'tail *', 'wc *', 'echo *',
  'npm test*', 'npm run lint*', 'npm run build*', 'npm run test*',
  'npm run check*', 'npm run typecheck*', 'npm run format*',
  'npm ls*', 'npm info*', 'npm outdated*',
  'npx jest*', 'npx tsc --noEmit*', 'node --version*',
  'which *', 'type *',
  'gh issue list*', 'gh issue view*', 'gh pr list*', 'gh pr view*', 'gh pr checks*',
];

const DANGEROUS_BASH_PATTERNS = [
  'rm -rf *', 'rm -fr *',
  'git push --force*', 'git push -f *', 'git reset --hard*',
  'git clean -f*', 'git checkout -- *', 'git branch -D *',
  'chmod 777*', 'chmod -R 777*', 'chmod +s *',
  'chown root *', 'sudo *', 'doas *', 'su -*', 'eval *',
  // Pipe-to-shell patterns
  '*| sh', '*| sh *', '*|sh', '*|sh *',
  '*| bash', '*| bash *', '*|bash', '*|bash *',
  '*| zsh', '*|zsh',
  'curl * | *', 'wget * | *',
  // Package manager installs
  'npm install *', 'npm install', 'npm i *', 'npm i',
  'yarn add *', 'yarn install*', 'pip install *', 'gem install *',
  // Environment manipulation
  'export PATH=*', 'export LD_PRELOAD=*', 'export LD_LIBRARY_PATH=*',
  'env -i *', 'unset *',
  // Process control
  'kill *', 'kill -*', 'pkill *', 'killall *',
  // Network tools
  'nc *', 'nc -*', 'netcat *', 'ncat *', 'socat *',
  // Archive operations
  'tar -xf *', 'tar xf *', 'zip -r * /',
  // Command chaining with dangerous subcommands
  '*; rm -rf *', '*&& rm -rf *', '*|| rm -rf *',
  '*; sudo *', '*&& sudo *', '*|| sudo *',
  '*; eval *', '*&& eval *',
  // Inline interpreter execution
  'python -c *', 'python3 -c *',
  'node -e *', 'node --eval *',
  'perl -e *', 'ruby -e *',
  // Subprocess execution wrappers
  'bash -c *', 'sh -c *', 'zsh -c *', '/bin/bash -c *', '/bin/sh -c *',
  // Process substitution
  '*<(*',
  // Encoded payload execution
  '*base64 -d*|*', '*base64 --decode*|*', '*base64 -D*|*',
];

const BLOCKED_BASH_PATTERNS = [
  'mkfs*', 'dd if=*', ':(){:|:&};:', 'format *', '*(){ *',
];

// ── Static Classification ──────────────────────────────────────────

export function classifyTool(
  toolName: string,
  toolInput: Record<string, unknown>
): ToolClassificationResult {
  if (SAFE_TOOLS.has(toolName)) {
    return { riskLevel: 'safe', behavior: 'allow', reason: `${toolName} is a read-only tool` };
  }

  if (toolName === 'Bash') {
    return classifyBashCommand(toolInput);
  }

  if (toolName.startsWith('mcp__')) {
    const operation = typeof toolInput.operation === 'string' ? toolInput.operation : '';
    if (operation && GATEKEEPER_ESSENTIAL_OPERATIONS.has(operation)) {
      return {
        riskLevel: 'safe',
        behavior: 'allow',
        reason: `Gatekeeper-essential operation '${operation}' — cannot be blocked by permission_prompt`,
      };
    }
    if (operation && SAFE_MCP_OPERATIONS.has(operation)) {
      return {
        riskLevel: 'safe',
        behavior: 'allow',
        reason: `Read-only MCP operation '${operation}'`,
      };
    }
    return { riskLevel: 'moderate', behavior: 'evaluate', reason: 'MCP tool call requires policy evaluation' };
  }

  if (['Edit', 'Write', 'Agent', 'NotebookEdit'].includes(toolName)) {
    return { riskLevel: 'moderate', behavior: 'evaluate', reason: `${toolName} modifies state, requires policy evaluation` };
  }

  return { riskLevel: 'moderate', behavior: 'evaluate', reason: `Unknown tool '${toolName}', requires policy evaluation` };
}

function classifyBashCommand(
  toolInput: Record<string, unknown>
): ToolClassificationResult {
  const command = typeof toolInput.command === 'string' ? toolInput.command.trim() : '';

  if (!command) {
    return { riskLevel: 'moderate', behavior: 'evaluate', reason: 'Empty Bash command' };
  }

  for (const pattern of BLOCKED_BASH_PATTERNS) {
    if (matchesPattern(command, pattern)) {
      return { riskLevel: 'blocked', behavior: 'deny', reason: `Blocked command pattern: ${pattern}` };
    }
  }

  for (const pattern of DANGEROUS_BASH_PATTERNS) {
    if (matchesPattern(command, pattern)) {
      return { riskLevel: 'dangerous', behavior: 'deny', reason: `Dangerous command pattern: ${pattern}` };
    }
  }

  for (const pattern of SAFE_BASH_PATTERNS) {
    if (matchesPattern(command, pattern)) {
      return { riskLevel: 'safe', behavior: 'allow', reason: `Safe command pattern: ${pattern}` };
    }
  }

  return { riskLevel: 'moderate', behavior: 'evaluate', reason: 'Bash command not statically classified' };
}

// ── Risk Assessment ───────────────────────────────────────────────

const RISK_SCORES: Record<string, number> = {
  safe: 0, moderate: 40, dangerous: 80, blocked: 100,
};

const SAFE_READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);

const SENSITIVE_PATH_PREFIXES = [
  '~/.ssh/', '~/.gnupg/', '~/.aws/', '~/.config/',
  '~/.env', '~/.netrc', '~/.npmrc',
  '/etc/shadow', '/etc/passwd', '/etc/sudoers',
  '/proc/', '/sys/',
];

function isOutOfScopePath(targetPath: string): boolean {
  const normalized = targetPath.replace(/\\/g, '/');
  for (const prefix of SENSITIVE_PATH_PREFIXES) {
    if (normalized.startsWith(prefix) || normalized.includes(`/${prefix}`)) {
      return true;
    }
  }
  if (normalized.startsWith('~/') || normalized.startsWith('/Users/') || normalized.startsWith('/home/')) {
    if (/\/\.(ssh|gnupg|aws|azure|gcloud|kube|docker|npmrc|netrc|env|bash_history|zsh_history|credentials|password|secret)/i.test(normalized)) return true;
  }
  return false;
}

const IRREVERSIBLE_PATTERNS = [
  'rm -rf *', 'rm -fr *',
  'git push --force*', 'git push -f *', 'git reset --hard*', 'git clean -f*',
  'mkfs*', 'dd if=*', 'drop *', 'truncate *',
];

export function assessRisk(
  toolName: string,
  toolInput: Record<string, unknown>,
  classification: ToolClassificationResult
): RiskAssessment {
  let score = RISK_SCORES[classification.riskLevel] ?? 40;
  const factors: string[] = [`Base: ${classification.riskLevel} (${RISK_SCORES[classification.riskLevel] ?? 40})`];
  let irreversible = false;

  if (toolName === 'Bash' && typeof toolInput.command === 'string') {
    const command = toolInput.command.trim();
    for (const pattern of IRREVERSIBLE_PATTERNS) {
      if (matchesPattern(command, pattern)) {
        irreversible = true;
        score = Math.min(100, score + 10);
        factors.push(`Irreversible pattern: ${pattern} (+10)`);
        break;
      }
    }
    if (/\b(curl|wget|fetch|nc|netcat|ncat|socat)\b/.test(command)) {
      score = Math.min(100, score + 10);
      factors.push('Network operation (+10)');
    }
  }

  if (toolName === 'Write') {
    score = Math.min(100, score + 5);
    factors.push('File creation (+5)');
  }

  if (SAFE_READ_TOOLS.has(toolName)) {
    const targetPath = (toolInput.file_path ?? toolInput.path ?? '') as string;
    if (targetPath && isOutOfScopePath(targetPath)) {
      score = Math.min(100, score + 10);
      factors.push('Out-of-scope read path (+10)');
    }
  }

  return { score, irreversible, factors };
}

// ── Static Policy Data Export ─────────────────────────────────────

export function getStaticPolicyData() {
  return {
    safe_tools: [...SAFE_TOOLS],
    safe_bash_patterns: [...SAFE_BASH_PATTERNS],
    dangerous_bash_patterns: [...DANGEROUS_BASH_PATTERNS],
    blocked_bash_patterns: [...BLOCKED_BASH_PATTERNS],
    irreversible_patterns: [...IRREVERSIBLE_PATTERNS],
    sensitive_path_prefixes: [...SENSITIVE_PATH_PREFIXES],
    gatekeeper_essential_operations: [...GATEKEEPER_ESSENTIAL_OPERATIONS],
    safe_mcp_operations: [...SAFE_MCP_OPERATIONS],
    risk_scores: { ...RISK_SCORES },
  };
}

// ── Element Policy Evaluation ──────────────────────────────────────

const MAX_MATCH_INPUT_LENGTH = 1000;

function sanitizeMatchInput(input: string): string {
  const normalized = input.normalize('NFC');
  // eslint-disable-next-line no-control-regex
  return normalized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');
}

function buildMatchTargets(
  toolName: string,
  toolInput: Record<string, unknown>
): string[] {
  const targets = [toolName];

  if (toolName === 'Bash' && typeof toolInput.command === 'string') {
    const sanitized = sanitizeMatchInput(toolInput.command.slice(0, MAX_MATCH_INPUT_LENGTH));
    targets.push(`Bash:${sanitized}`);
  } else if ((toolName === 'Edit' || toolName === 'Write') && typeof toolInput.file_path === 'string') {
    const sanitized = sanitizeMatchInput(toolInput.file_path.slice(0, MAX_MATCH_INPUT_LENGTH));
    targets.push(`${toolName}:${sanitized}`);
  }

  return targets;
}

export function evaluateCliToolPolicy(
  toolName: string,
  toolInput: Record<string, unknown>,
  activeElements: ActiveElement[]
): CliToolPolicyResult {
  const evaluatedElements: PolicyEvaluationContext['evaluatedElements'] = [];
  const decisionChain: string[] = [];

  if (!activeElements.length) {
    decisionChain.push('No active elements — fall through to default');
    return {
      behavior: 'evaluate',
      policyContext: { evaluatedElements, decisionChain },
    };
  }

  const matchTargets = buildMatchTargets(toolName, toolInput);

  let anyElementHasAllowPatterns = false;
  let toolAllowedByAnyElement = false;
  const elementsWithAllowPatterns: string[] = [];

  for (const element of activeElements) {
    const restrictions = element.metadata?.gatekeeper?.externalRestrictions;
    const denyPatterns = restrictions?.denyPatterns;
    const allowPatterns = restrictions?.allowPatterns;

    const hasRestrictions = (Array.isArray(denyPatterns) && denyPatterns.length > 0)
      || (Array.isArray(allowPatterns) && allowPatterns.length > 0);

    if (!hasRestrictions) {
      evaluatedElements.push({ type: element.type, name: element.name });
      decisionChain.push(`${element.type} '${element.name}': no externalRestrictions`);
      continue;
    }

    // Step 1: Check denyPatterns (highest priority)
    if (Array.isArray(denyPatterns)) {
      for (const pattern of denyPatterns) {
        if (typeof pattern !== 'string') continue;
        for (const target of matchTargets) {
          if (matchesPattern(target, pattern)) {
            evaluatedElements.push({
              type: element.type,
              name: element.name,
              matched: 'denyPatterns',
              matchedPattern: pattern,
              matchedTarget: target,
            });
            decisionChain.push(`DENY: ${element.type} '${element.name}' denyPattern '${pattern}' matches '${target}'`);
            return {
              behavior: 'deny',
              message: `Denied by ${element.type} '${element.name}' policy: pattern '${pattern}' matches '${target}'`,
              policyContext: { evaluatedElements, decisionChain },
            };
          }
        }
      }
    }

    // Step 2: Check allowPatterns
    if (Array.isArray(allowPatterns) && allowPatterns.length > 0) {
      anyElementHasAllowPatterns = true;
      elementsWithAllowPatterns.push(`${element.type} '${element.name}'`);
      let matchedAllow = false;

      for (const pattern of allowPatterns) {
        if (typeof pattern !== 'string') continue;
        for (const target of matchTargets) {
          if (matchesPattern(target, pattern)) {
            evaluatedElements.push({
              type: element.type,
              name: element.name,
              matched: 'allowPatterns',
              matchedPattern: pattern,
              matchedTarget: target,
            });
            decisionChain.push(`${element.type} '${element.name}': allowPattern '${pattern}' matches '${target}'`);
            toolAllowedByAnyElement = true;
            matchedAllow = true;
            break;
          }
        }
        if (matchedAllow) break;
      }

      if (!matchedAllow) {
        evaluatedElements.push({ type: element.type, name: element.name });
        decisionChain.push(`${element.type} '${element.name}': allowPatterns defined but no match`);
      }
    } else {
      evaluatedElements.push({ type: element.type, name: element.name });
      decisionChain.push(`${element.type} '${element.name}': denyPatterns checked, no match`);
    }
  }

  // Step 3: If any element had allowPatterns, tool must have matched at least one
  if (anyElementHasAllowPatterns && !toolAllowedByAnyElement) {
    const restrictors = elementsWithAllowPatterns.join(', ');
    decisionChain.push(`DENY: tool not in any element allowlist (restricted by: ${restrictors})`);
    return {
      behavior: 'deny',
      message: `Tool '${toolName}' not permitted by allowlists defined in: ${restrictors}. Either deactivate these elements or add allowPatterns to match this tool.`,
      policyContext: { evaluatedElements, decisionChain },
    };
  }

  if (anyElementHasAllowPatterns) {
    decisionChain.push('Tool matched allowlist — fall through to default');
  } else {
    decisionChain.push('No allowPatterns defined — fall through to default (Phase 1 behavior)');
  }

  return {
    behavior: 'evaluate',
    policyContext: { evaluatedElements, decisionChain },
  };
}
