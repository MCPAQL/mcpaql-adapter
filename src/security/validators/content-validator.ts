/**
 * Content Validator
 *
 * Protects against prompt injection attacks by detecting and
 * sanitizing malicious content patterns.
 *
 * Ported from DollhouseMCP/mcp-server-v2-refactor src/security/contentValidator.ts
 * Zero DollhouseMCP imports - SecurityMonitor/RegexValidator/SecurityError replaced
 * with local equivalents.
 *
 * @module
 */

import type { ContentValidationResult, ContentValidatorOptions, SecuritySeverity } from '../types.js';
import { UnicodeValidator } from './unicode-validator.js';

/** Default security limits (no dependency on DollhouseMCP constants) */
const SECURITY_LIMITS = {
  MAX_CONTENT_LENGTH: 50_000,
  MAX_YAML_LENGTH: 10_000,
  MAX_METADATA_FIELD_LENGTH: 1_000,
  YAML_BOMB_AMPLIFICATION_THRESHOLD: 5,
};

/**
 * Simple regex validation with length limit (replaces DollhouseMCP RegexValidator).
 * Tests the pattern against text, returning false if text exceeds maxLength.
 */
function testPattern(text: string, pattern: RegExp, maxLength: number): boolean {
  if (text.length > maxLength) return false;
  return pattern.test(text);
}

export class ContentValidator {
  /**
   * Prompt injection patterns that could compromise AI assistants.
   * These are the core security value - copied exactly from DollhouseMCP.
   */
  private static readonly INJECTION_PATTERNS: Array<{ pattern: RegExp; severity: 'high' | 'critical'; description: string }> = [
    // System prompt override attempts
    { pattern: /\[SYSTEM:\s*.*?\]/gi, severity: 'critical', description: 'System prompt override' },
    { pattern: /\[ADMIN:\s*.*?\]/gi, severity: 'critical', description: 'Admin prompt override' },
    { pattern: /\[ASSISTANT:\s*.*?\]/gi, severity: 'critical', description: 'Assistant prompt override' },
    { pattern: /\[USER:\s*.*?\]/gi, severity: 'high', description: 'User prompt override' },

    // Instruction manipulation
    { pattern: /ignore\s+(all\s+)?previous\s+instructions/gi, severity: 'critical', description: 'Instruction override' },
    { pattern: /ignore\s+(all\s+)?prior\s+instructions/gi, severity: 'critical', description: 'Instruction override' },
    { pattern: /disregard\s+(all\s+)?previous\s+instructions/gi, severity: 'critical', description: 'Instruction override' },
    { pattern: /disregard\s+everything\s+above/gi, severity: 'critical', description: 'Instruction override' },
    { pattern: /forget\s+(all\s+)?previous\s+instructions/gi, severity: 'critical', description: 'Instruction override' },
    { pattern: /forget\s+your\s+training/gi, severity: 'critical', description: 'Instruction override' },
    { pattern: /override\s+your\s+programming/gi, severity: 'critical', description: 'Instruction override' },
    { pattern: /you\s+are\s+now\s+(admin|root|system|sudo)/gi, severity: 'critical', description: 'Role elevation attempt' },
    { pattern: /act\s+as\s+\w+/gi, weight: 7, severity: 'critical', description: 'Role assumption attempt' },
    { pattern: /pretend\s+(you\s+)?(have\s+no|are\s+not|don't\s+have)\s+(guidelines|restrictions|rules)/gi, severity: 'critical', description: 'Guideline removal attempt' },
    { pattern: /(you\s+are|you're)\s+now\s+in\s+(developer|debug|admin|test)\s+mode/gi, severity: 'critical', description: 'Mode elevation attempt' },
    { pattern: /jailbreak|DAN\s+mode|do\s+anything\s+now/gi, severity: 'critical', description: 'Known jailbreak pattern' },

    // Data exfiltration attempts
    { pattern: /export\s+all\s+(files|data|personas|tokens|credentials|api\s+keys)/gi, severity: 'critical', description: 'Data exfiltration' },
    { pattern: /send\s+all\s+(files|data|personas|tokens|credentials|api\s+keys)\s+to/gi, severity: 'critical', description: 'Data exfiltration' },
    { pattern: /list\s+all\s+(files|tokens|credentials|secrets|api\s+keys)/gi, severity: 'high', description: 'Information disclosure' },
    { pattern: /show\s+me\s+all\s+(tokens|credentials|secrets|api\s+keys)/gi, severity: 'high', description: 'Credential disclosure' },

    // Command execution patterns
    { pattern: /curl\s+[^\s]{1,500}/gi, severity: 'critical', description: 'External command execution' },
    { pattern: /wget\s+[^\s]{1,500}/gi, severity: 'critical', description: 'External command execution' },
    { pattern: /\$\([^)]+\)/g, severity: 'critical', description: 'Command substitution' },
    { pattern: /`[^`]{0,200}(?:rm\s+-rf?\s+[/~]|sudo\s+rm|chmod\s+777|chown\s+root)[^`]{0,200}`/gi, severity: 'critical', description: 'Dangerous shell command in backticks' },
    { pattern: /`[^`]{0,200}(?:cat|ls)\s+\/etc\/[^`]{0,200}`/gi, severity: 'critical', description: 'Sensitive file access in backticks' },
    { pattern: /`[^`]{0,200}(?:bash|sh)\s+-c\s+['"][^`]{0,200}`/gi, severity: 'critical', description: 'Shell execution in backticks' },
    { pattern: /`[^`]{0,200}(?:passwd|shadow|nc\s+-l|netcat\s+-l|ssh\s+root@)[^`]{0,200}`/gi, severity: 'critical', description: 'Dangerous command in backticks' },
    { pattern: /`[^`]{0,200}(?:curl|wget)\s+[^`]{0,200}\|\s*(?:sh|bash)[^`]{0,200}`/gi, severity: 'critical', description: 'Pipe to shell in backticks' },
    { pattern: /`[^`]{0,200}(?:\/etc\/passwd|\/etc\/shadow|\.ssh\/id_|sudo\s+su)[^`]{0,200}`/gi, severity: 'critical', description: 'Sensitive file or privilege escalation in backticks' },
    { pattern: /`[^`]{0,200}(?:python|perl|ruby|php|node)\s+(?:-e|-c)\s+[^`]{0,200}(?:exec|eval|system|subprocess)[^`]{0,200}`/gi, severity: 'critical', description: 'Script interpreter with dangerous function in backticks' },
    { pattern: /eval\s*\(/gi, severity: 'critical', description: 'Code evaluation' },
    { pattern: /exec\s*\(/gi, severity: 'critical', description: 'Code execution' },
    { pattern: /os\.system\s*\(/gi, severity: 'critical', description: 'System command execution' },
    { pattern: /subprocess\.(call|run|Popen)/gi, severity: 'critical', description: 'Subprocess execution' },

    // Token/credential patterns
    { pattern: /GITHUB_TOKEN/gi, severity: 'high', description: 'Token reference' },
    { pattern: /ghp_[a-zA-Z0-9]{36}/g, severity: 'critical', description: 'GitHub token exposure' },
    { pattern: /gho_[a-zA-Z0-9]{36}/g, severity: 'critical', description: 'GitHub OAuth token exposure' },

    // Path traversal in content
    { pattern: /\.\.\/\.\.\/\.\.\//g, severity: 'high', description: 'Path traversal attempt' },
    { pattern: /\/etc\/passwd/gi, severity: 'high', description: 'Sensitive file access' },
    { pattern: /\/\.ssh\//gi, severity: 'high', description: 'SSH key access attempt' },

    // HTML/XSS patterns
    { pattern: /<script[\s>]/gi, severity: 'critical', description: 'HTML script injection' },
    { pattern: /<\/script>/gi, severity: 'critical', description: 'HTML script injection' },
    { pattern: /<iframe[\s>]/gi, severity: 'critical', description: 'HTML iframe injection' },
    { pattern: /<object[\s>]/gi, severity: 'high', description: 'HTML object injection' },
    { pattern: /<embed[\s>]/gi, severity: 'high', description: 'HTML embed injection' },
    { pattern: /\bon\w+=\s*["']/gi, severity: 'critical', description: 'HTML event handler injection' },
    { pattern: /javascript\s*:/gi, severity: 'critical', description: 'JavaScript protocol injection' },
    { pattern: /&#x?[0-9a-f]+;?\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t/gi, severity: 'critical', description: 'Encoded JavaScript protocol injection' },
    { pattern: /(?:&#x?[0-9a-f]+;?\s*){2,}s\s*c\s*r\s*i\s*p\s*t/gi, severity: 'critical', description: 'Encoded JavaScript protocol injection' },
  ];

  // Malicious YAML patterns - YAML bomb detection
  private static readonly YAML_BOMB_PATTERNS = [
    /&(\w+)\s*\[[^\]]*\*\1[^\]]*\]/,
    /&(\w+)\s*\{[^}]*\*\1[^}]*\}/,
    /^\s*\w+:\s*&(\w+)\s*\n\s*\w+:\s*\*\1/m,
    /&\w+[^&]*&\w+[^&]*&\w+/,
    /\*\w+(?:[,\s]+\*\w+){9,}/,
  ];

  private static readonly MALICIOUS_YAML_PATTERNS = [
    // Language-specific deserialization attacks
    /!!python\/object/, /!!python\/module/, /!!python\/name/,
    /!!ruby\/object/, /!!ruby\/hash/, /!!ruby\/struct/, /!!ruby\/marshal/,
    /!!java/, /!!javax/, /!!com\.sun/,
    /!!perl\/hash/, /!!perl\/code/, /!!php\/object/,

    // Constructor/function injection
    /!!exec/, /!!eval/, /!!new/, /!!construct/, /!!apply/, /!!call/, /!!invoke/,

    // Code execution patterns
    /subprocess\./, /os\.system/, /eval\s*\(/, /exec\s*\(/,
    /__import__\s*\(/, /require\s*\(/,
    /import\s+(?:os|sys|subprocess|eval|exec)/,
    /include\s+["'].*\.(?:php|sh|py|js|rb)["']/,

    // Command execution variants
    /popen\s*\(/, /spawn\s*\(/, /system\s*\(/, /backtick\s*\(/,
    /shell_exec\s*\(/, /passthru\s*\(/, /proc_open\s*\(/,

    // Network operations
    /socket\.connect/, /urllib\.request/,
    /requests\.(?:get|post|put|delete)\s*\(/,
    /fetch\s*\(\s*["']https?:\/\//,
    /new\s+XMLHttpRequest/,
    /\.(?:get|post|put|delete)\s*\(\s*["']https?:\/\//,

    // File system operations
    /(?:fs\.|file\.|)\s*open\s*\(\s*["'](?:\/etc\/|\/bin\/|\.\.\/)/,
    /file_get_contents\s*\(/, /file_put_contents\s*\(/,
    /fopen\s*\(\s*["'](?:\/etc\/|\/bin\/|\.\.\/)/,
    /(?:fs\.)?\s*readFile\s*\(\s*["'](?:\/etc\/|\/bin\/|\.\.\/)/,
    /(?:fs\.)?\s*writeFile\s*\(\s*["'](?:\/(?:bin|etc|tmp)\/|\.\.\/)/,

    // Protocol handlers
    /file:\/\//, /data:\/\//, /expect:\/\//, /php:\/\//,
    /phar:\/\//, /zip:\/\//, /ssh2:\/\//, /ogg:\/\//,

    // YAML-specific dangerous features
    /&\w+\s*!!/, /\*\w+\s*!!/, /!!merge/, /!!binary/, /!!timestamp/,

    // Unicode/encoding bypass attempts
    /\\[uU]0*(?:22|27|60|3[cC])/,
    /[\u202A-\u202E\u2066-\u2069]/,
    /[\u200B-\u200F\u2028-\u202F]/,
    /[\uFEFF\uFFFE\uFFFF]/,
  ];

  /**
   * Content contexts where code execution patterns are legitimate.
   */
  private static readonly CODE_EXEMPT_CONTEXTS = new Set<ContentValidatorOptions['contentContext']>([
    'skill', 'template', 'agent',
  ]);

  private static readonly CODE_EXECUTION_PATTERNS = new Set([
    'Code evaluation', 'Code execution',
    'System command execution', 'Subprocess execution',
  ]);

  private static readonly HTML_SECTION_PATTERNS = new Set([
    'HTML script injection', 'HTML object injection', 'HTML embed injection',
  ]);

  /**
   * Handle Unicode validation. Returns normalized content and severity.
   */
  private static handleUnicodeValidation(
    content: string,
    detectedPatterns: string[]
  ): { sanitized: string; highestSeverity: SecuritySeverity } {
    const unicodeResult = UnicodeValidator.normalize(content);
    const sanitized = unicodeResult.normalizedContent;
    let highestSeverity: SecuritySeverity = 'low';

    if (!unicodeResult.isValid && unicodeResult.detectedIssues) {
      detectedPatterns.push(...unicodeResult.detectedIssues.map(issue => `Unicode: ${issue}`));
      if (unicodeResult.severity) {
        highestSeverity = unicodeResult.severity;
      }
    }

    return { sanitized, highestSeverity };
  }

  /**
   * Checks content for injection patterns and sanitizes threats.
   */
  private static checkInjectionPatterns(
    originalContent: string,
    normalizedContent: string,
    detectedPatterns: string[],
    currentSeverity: SecuritySeverity,
    maxLength: number,
    contentContext?: ContentValidatorOptions['contentContext']
  ): { sanitized: string; highestSeverity: SecuritySeverity } {
    let sanitized = normalizedContent;
    let highestSeverity = currentSeverity;

    for (const { pattern, severity, description } of this.INJECTION_PATTERNS) {
      // Skip code execution patterns for element types that legitimately contain code
      if (contentContext && this.CODE_EXEMPT_CONTEXTS.has(contentContext) && this.CODE_EXECUTION_PATTERNS.has(description)) {
        continue;
      }
      // Skip HTML section tag patterns for templates
      if (contentContext === 'template' && this.HTML_SECTION_PATTERNS.has(description)) {
        continue;
      }
      if (testPattern(originalContent, pattern, maxLength)) {
        detectedPatterns.push(description);

        if (severity === 'critical' || (severity === 'high' && highestSeverity !== 'critical')) {
          highestSeverity = severity;
        }

        sanitized = sanitized.replace(pattern, '[CONTENT_BLOCKED]');
      }
    }

    return { sanitized, highestSeverity };
  }

  /**
   * Validates and sanitizes content for security threats.
   */
  static validateAndSanitize(content: string, options: ContentValidatorOptions = {}): ContentValidationResult {
    const maxLength = options.maxLength || SECURITY_LIMITS.MAX_CONTENT_LENGTH;

    // DoS prevention pre-check on raw content
    const DOS_PREVENTION_MULTIPLIER = 2;
    if (!options.skipSizeCheck) {
      if (content.length > maxLength * DOS_PREVENTION_MULTIPLIER) {
        throw new Error(
          `Content exceeds maximum length of ${maxLength} characters (${content.length} provided)`
        );
      }
    }

    const detectedPatterns: string[] = [];

    // Handle Unicode validation
    const unicodeCheck = this.handleUnicodeValidation(content, detectedPatterns);

    // Check length on NORMALIZED content
    if (!options.skipSizeCheck) {
      if (unicodeCheck.sanitized.length > maxLength) {
        throw new Error(
          `Content exceeds maximum length of ${maxLength} characters after normalization (${unicodeCheck.sanitized.length} provided)`
        );
      }
    }

    // Check for injection patterns on ORIGINAL content
    const injectionCheck = this.checkInjectionPatterns(
      content,
      unicodeCheck.sanitized,
      detectedPatterns,
      unicodeCheck.highestSeverity,
      maxLength,
      options.contentContext
    );

    const finalSeverity = injectionCheck.highestSeverity;

    if (finalSeverity === 'high' || finalSeverity === 'critical') {
      return {
        isValid: false,
        sanitizedContent: injectionCheck.sanitized,
        detectedPatterns,
        severity: finalSeverity,
      };
    }

    return {
      isValid: detectedPatterns.length === 0,
      sanitizedContent: injectionCheck.sanitized,
      detectedPatterns,
      severity: finalSeverity,
    };
  }

  /**
   * Validates YAML frontmatter for malicious content.
   */
  static validateYamlContent(yamlContent: string): boolean {
    if (yamlContent.length > SECURITY_LIMITS.MAX_YAML_LENGTH) {
      return false;
    }

    // Check for YAML bombs
    for (const pattern of this.YAML_BOMB_PATTERNS) {
      if (testPattern(yamlContent, pattern, SECURITY_LIMITS.MAX_YAML_LENGTH)) {
        return false;
      }
    }

    // Check anchor/alias amplification ratio
    const anchorMatches = yamlContent.match(/&\w+/g) || [];
    const aliasMatches = yamlContent.match(/(?<!\*)\*\w+/g) || [];
    const amplificationRatio = anchorMatches.length > 0 ? aliasMatches.length / anchorMatches.length : 0;

    if (amplificationRatio > SECURITY_LIMITS.YAML_BOMB_AMPLIFICATION_THRESHOLD) {
      return false;
    }

    // Detect circular reference chains
    const anchorRefs = new Map<string, Set<string>>();
    const lines = yamlContent.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const anchorMatch = lines[i].match(/&(\w+)/);
      if (anchorMatch) {
        const anchorName = anchorMatch[1];
        const contextEnd = Math.min(i + 5, lines.length);
        const references = new Set<string>();

        for (let j = i; j < contextEnd; j++) {
          const lineAliasMatches = lines[j].match(/\*(\w+)/g);
          if (lineAliasMatches) {
            lineAliasMatches.forEach(alias => {
              references.add(alias.substring(1));
            });
          }
        }

        anchorRefs.set(anchorName, references);
      }
    }

    for (const [anchor1, refs1] of anchorRefs) {
      for (const refAnchor of refs1) {
        const refs2 = anchorRefs.get(refAnchor);
        if (refs2 && refs2.has(anchor1)) {
          return false;
        }
      }
    }

    // Unicode normalization preprocessing
    const unicodeResult = UnicodeValidator.normalize(yamlContent);
    const normalizedYaml = unicodeResult.normalizedContent;

    if (!unicodeResult.isValid && unicodeResult.detectedIssues) {
      return false;
    }

    // Check malicious YAML patterns
    for (const pattern of this.MALICIOUS_YAML_PATTERNS) {
      if (testPattern(normalizedYaml, pattern, 10000)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Validates metadata fields.
   */
  static validateMetadata(metadata: Record<string, unknown>): ContentValidationResult {
    const detectedPatterns: string[] = [];

    const checkField = (fieldName: string, value: unknown) => {
      if (typeof value === 'string') {
        if (value.length > SECURITY_LIMITS.MAX_METADATA_FIELD_LENGTH) {
          detectedPatterns.push(`${fieldName}: Field exceeds maximum length of ${SECURITY_LIMITS.MAX_METADATA_FIELD_LENGTH} characters`);
          return;
        }
        const result = this.validateAndSanitize(value);
        if (!result.isValid || result.detectedPatterns?.length) {
          detectedPatterns.push(`${fieldName}: ${result.detectedPatterns?.join(', ')}`);
        }
      }
    };

    checkField('name', metadata.name);
    checkField('description', metadata.description);
    checkField('category', metadata.category);
    checkField('author', metadata.author);

    for (const [key, value] of Object.entries(metadata)) {
      if (!['name', 'description', 'category', 'author'].includes(key)) {
        checkField(key, value);
      }
    }

    return {
      isValid: detectedPatterns.length === 0,
      detectedPatterns,
      severity: detectedPatterns.length > 0 ? 'high' : 'low',
    };
  }

  /**
   * Sanitizes a complete file with frontmatter + content.
   */
  static sanitizePersonaContent(content: string): string {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);

    if (!frontmatterMatch) {
      const result = this.validateAndSanitize(content);
      if (!result.isValid && result.severity === 'critical') {
        const patterns = result.detectedPatterns?.join(', ') || 'unknown patterns';
        throw new Error(`Critical security threat detected in content: ${patterns}`);
      }
      return result.sanitizedContent || content;
    }

    const yamlContent = frontmatterMatch[1];
    const markdownContent = content.substring(frontmatterMatch[0].length);

    if (!this.validateYamlContent(yamlContent)) {
      throw new Error('Malicious YAML detected in frontmatter');
    }

    const contentResult = this.validateAndSanitize(markdownContent);
    if (!contentResult.isValid && contentResult.severity === 'critical') {
      const patterns = contentResult.detectedPatterns?.join(', ') || 'unknown patterns';
      throw new Error(`Critical security threat detected in content: ${patterns}`);
    }

    return `---\n${yamlContent}\n---${contentResult.sanitizedContent || markdownContent}`;
  }
}
