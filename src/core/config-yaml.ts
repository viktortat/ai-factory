import path from 'path';
import { execFileSync } from 'child_process';
import { readTextFile, fileExists } from '../utils/fs.js';

// =============================================================================
// Types
// =============================================================================

export interface LanguageConfig {
  /** Language for AI-agent communication */
  ui: string;
  /** Language for generated artifacts */
  artifacts: string;
  /** How to handle technical terms: keep | translate */
  technical_terms: 'keep' | 'translate';
}

export interface PathsConfig {
  /** Project description file */
  description: string;
  /** Architecture guidelines file */
  architecture: string;
  /** Detailed documentation directory */
  docs: string;
  /** Roadmap file */
  roadmap: string;
  /** Research notes file */
  research: string;
  /** Top-level project rules file */
  rules_file: string;
  /** Fast plan file */
  plan: string;
  /** Plans directory */
  plans: string;
  /** Fix plan file */
  fix_plan: string;
  /** Security ignore-state file */
  security: string;
  /** References directory */
  references: string;
  /** Patches directory */
  patches: string;
  /** Evolutions directory */
  evolutions: string;
  /** Reflex loop state directory */
  evolution: string;
  /** Specs directory */
  specs: string;
  /** Rules directory */
  rules: string;
}

export interface WorkflowConfig {
  /** Automatically create .ai-factory/ directories */
  auto_create_dirs: boolean;
  /** Plan ID format: slug | timestamp | uuid */
  plan_id_format: 'slug' | 'timestamp' | 'uuid';
  /** Whether /aif-analyze updates ARCHITECTURE.md */
  analyze_updates_architecture: boolean;
  /** Whether /aif-architecture updates ROADMAP.md */
  architecture_updates_roadmap: boolean;
  /** Default verification mode: strict | normal | lenient */
  verify_mode: 'strict' | 'normal' | 'lenient';
}

export interface GitConfig {
  /** Whether AI Factory should use git-aware workflows */
  enabled: boolean;
  /** Default branch used for diffs, review, and merge targets */
  base_branch: string;
  /** Automatically create feature branches for plans */
  create_branches: boolean;
  /** Branch name prefix for new features */
  branch_prefix: string;
}

export interface RulesConfig {
  /** Base rules file path */
  base: string;
  /** Optional area-specific rules files */
  [area: string]: string | undefined;
}

export interface AiFactoryYamlConfig {
  language: LanguageConfig;
  paths: PathsConfig;
  workflow: WorkflowConfig;
  git: GitConfig;
  rules: RulesConfig;
}

// =============================================================================
// Defaults
// =============================================================================

const DEFAULT_LANGUAGE: LanguageConfig = {
  ui: 'en',
  artifacts: 'en',
  technical_terms: 'keep',
};

const DEFAULT_PATHS: PathsConfig = {
  description: '.ai-factory/DESCRIPTION.md',
  architecture: '.ai-factory/ARCHITECTURE.md',
  docs: 'docs/',
  roadmap: '.ai-factory/ROADMAP.md',
  research: '.ai-factory/RESEARCH.md',
  rules_file: '.ai-factory/RULES.md',
  plan: '.ai-factory/PLAN.md',
  plans: '.ai-factory/plans/',
  fix_plan: '.ai-factory/FIX_PLAN.md',
  security: '.ai-factory/SECURITY.md',
  references: '.ai-factory/references/',
  patches: '.ai-factory/patches/',
  evolutions: '.ai-factory/evolutions/',
  evolution: '.ai-factory/evolution/',
  specs: '.ai-factory/specs/',
  rules: '.ai-factory/rules/',
};

const DEFAULT_WORKFLOW: WorkflowConfig = {
  auto_create_dirs: true,
  plan_id_format: 'slug',
  analyze_updates_architecture: true,
  architecture_updates_roadmap: true,
  verify_mode: 'normal',
};

const DEFAULT_GIT: GitConfig = {
  enabled: true,
  base_branch: 'main',
  create_branches: true,
  branch_prefix: 'feature/',
};

const DEFAULT_RULES: RulesConfig = {
  base: '.ai-factory/rules/base.md',
};

const DEFAULT_CONFIG: AiFactoryYamlConfig = {
  language: DEFAULT_LANGUAGE,
  paths: DEFAULT_PATHS,
  workflow: DEFAULT_WORKFLOW,
  git: DEFAULT_GIT,
  rules: DEFAULT_RULES,
};

// =============================================================================
// Simple YAML Parser (line-based)
// =============================================================================

interface ParsedYaml {
  [key: string]: string | boolean | string[] | ParsedYaml;
}

/**
 * Simple line-based YAML parser for config.yaml files.
 * Handles nested objects, strings, booleans, numbers, and arrays.
 * Comments (# ...) and empty lines are ignored.
 */
function parseSimpleYaml(content: string): ParsedYaml {
  const result: ParsedYaml = {};
  const lines = content.split('\n');
  const stack: { indent: number; obj: ParsedYaml }[] = [{ indent: -1, obj: result }];

  for (const rawLine of lines) {
    // Skip empty lines and comments
    const line = rawLine.trimEnd();
    if (!line || line.trimStart().startsWith('#')) {
      continue;
    }

    const indent = line.search(/\S/);
    const trimmed = line.trim();

    // Pop stack to correct level
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const current = stack[stack.length - 1].obj;

    // Handle array items
    if (trimmed.startsWith('- ')) {
      const value = trimmed.slice(2).trim();
      // Find or create array
      const lastKey = Object.keys(current).pop();
      if (lastKey && Array.isArray(current[lastKey])) {
        (current[lastKey] as string[]).push(String(parseValue(value)));
      }
      continue;
    }

    // Handle key: value
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue;

    const key = trimmed.slice(0, colonIndex).trim();
    let value = trimmed.slice(colonIndex + 1).trim();

    if (!value) {
      // Nested object
      current[key] = {};
      stack.push({ indent, obj: current[key] as ParsedYaml });
    } else if (value.startsWith('[') && value.endsWith(']')) {
      // Inline array
      const items = value
        .slice(1, -1)
        .split(',')
        .map((s) => String(parseValue(s.trim())))
        .filter((s) => s !== '');
      current[key] = items;
    } else {
      current[key] = parseValue(value);
    }
  }

  return result;
}

function parseValue(value: string): string | boolean {
  // Remove quotes
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  // Boolean
  if (value === 'true') return true;
  if (value === 'false') return false;
  // Number (keep as string for simplicity)
  return value;
}

// =============================================================================
// Config Loader
// =============================================================================

const CONFIG_FILENAME = 'config.yaml';

/**
 * Load and parse .ai-factory/config.yaml from the project directory.
 * Returns defaults if file doesn't exist or is invalid.
 */
export async function loadConfigYaml(projectDir: string): Promise<AiFactoryYamlConfig> {
  const configPath = path.join(projectDir, '.ai-factory', CONFIG_FILENAME);
  const exists = await fileExists(configPath);
  const gitDefaults = await detectGitConfig(projectDir);

  if (!exists) {
    console.log('[config-yaml] No config.yaml found, using defaults');
    return { ...DEFAULT_CONFIG, git: gitDefaults };
  }

  const content = await readTextFile(configPath);
  if (!content) {
    console.log('[config-yaml] Failed to read config.yaml, using defaults');
    return { ...DEFAULT_CONFIG, git: gitDefaults };
  }

  try {
    const parsed = parseSimpleYaml(content);
    const config = mergeWithDefaults(parsed, gitDefaults);
    console.log('[config-yaml] Loaded config.yaml successfully');
    return config;
  } catch (error) {
    console.log('[config-yaml] Failed to parse config.yaml, using defaults:', error);
    return { ...DEFAULT_CONFIG, git: gitDefaults };
  }
}

function mergeWithDefaults(parsed: ParsedYaml, gitDefaults: GitConfig): AiFactoryYamlConfig {
  const paths = {
    ...DEFAULT_PATHS,
    ...(parsed.paths as ParsedYaml || {}),
  } as PathsConfig;
  const parsedRules = normalizeRulesConfig(parsed.rules as ParsedYaml | undefined, paths);
  const git = {
    ...gitDefaults,
    ...(parsed.git as ParsedYaml || {}),
  } as GitConfig;

  if (!git.enabled) {
    git.create_branches = false;
  }

  if (!git.base_branch) {
    git.base_branch = gitDefaults.base_branch;
  }

  return {
    language: {
      ...DEFAULT_LANGUAGE,
      ...(parsed.language as ParsedYaml || {}),
    },
    paths,
    workflow: {
      ...DEFAULT_WORKFLOW,
      ...(parsed.workflow as ParsedYaml || {}),
    },
    git,
    rules: {
      ...DEFAULT_RULES,
      ...parsedRules,
    },
  };
}

async function detectGitConfig(projectDir: string): Promise<GitConfig> {
  const gitPath = path.join(projectDir, '.git');
  const enabled = await fileExists(gitPath);

  if (!enabled) {
    return {
      ...DEFAULT_GIT,
      enabled: false,
      create_branches: false,
    };
  }

  return {
    ...DEFAULT_GIT,
    enabled: true,
    base_branch: detectGitBaseBranch(projectDir),
  };
}

function detectGitBaseBranch(projectDir: string): string {
  try {
    const remoteHead = execFileSync(
      'git',
      ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
      {
        cwd: projectDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();

    if (remoteHead) {
      return remoteHead.replace(/^origin\//, '');
    }
  } catch {
    // Fall through to the next detection strategy.
  }

  try {
    const remoteInfo = execFileSync('git', ['remote', 'show', 'origin'], {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = remoteInfo.match(/HEAD branch:\s+(.+)/);
    if (match?.[1]) {
      return match[1].trim();
    }
  } catch {
    // Fall through to local branch heuristics.
  }

  for (const candidate of ['main', 'master', '2.x', 'trunk', 'develop']) {
    try {
      execFileSync('git', ['show-ref', '--verify', `refs/heads/${candidate}`], {
        cwd: projectDir,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return candidate;
    } catch {
      // Continue checking the next candidate.
    }
  }

  return DEFAULT_GIT.base_branch;
}

function normalizeRulesConfig(parsedRules: ParsedYaml | undefined, paths: PathsConfig): RulesConfig {
  if (!parsedRules) {
    return DEFAULT_RULES;
  }

  const normalized: RulesConfig = { ...DEFAULT_RULES };

  for (const [key, value] of Object.entries(parsedRules)) {
    if (typeof value !== 'string') {
      continue;
    }

    // Backward compatibility: plain filenames still resolve from paths.rules.
    normalized[key] = /[\\/]/.test(value) ? value : path.posix.join(paths.rules, value);
  }

  return normalized;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get paths configuration from config.
 * Returns defaults if config is null.
 */
export function getConfigPaths(config: AiFactoryYamlConfig | null): PathsConfig {
  return config?.paths ?? DEFAULT_PATHS;
}

/**
 * Get language configuration from config.
 * Returns defaults if config is null.
 */
export function getConfigLanguage(config: AiFactoryYamlConfig | null): LanguageConfig {
  return config?.language ?? DEFAULT_LANGUAGE;
}

/**
 * Get workflow configuration from config.
 * Returns defaults if config is null.
 */
export function getConfigWorkflow(config: AiFactoryYamlConfig | null): WorkflowConfig {
  return config?.workflow ?? DEFAULT_WORKFLOW;
}

/**
 * Get rules configuration from config.
 * Returns defaults if config is null.
 */
export function getConfigRules(config: AiFactoryYamlConfig | null): RulesConfig {
  return config?.rules ?? DEFAULT_RULES;
}

/**
 * Get git configuration from config.
 * Returns defaults if config is null.
 */
export function getConfigGit(config: AiFactoryYamlConfig | null): GitConfig {
  return config?.git ?? DEFAULT_GIT;
}
