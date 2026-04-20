import path from 'path';
import { createRequire } from 'module';
import { readJsonFile, writeJsonFile, fileExists, getSubagentsDir, listFilesRecursive } from '../utils/fs.js';
import { findAgentConfig, getAgentConfig } from './agents.js';
import { loadAllExtensions } from './extensions.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json');

export interface McpConfig {
  github: boolean;
  filesystem: boolean;
  postgres: boolean;
  chromeDevtools: boolean;
  playwright: boolean;
}

export interface ManagedArtifactState {
  sourceHash: string;
  installedHash: string;
}

export interface AgentFileSource {
  kind: 'bundled' | 'extension';
  sourcePath: string;
  extensionName?: string;
}

export interface AgentInstallation {
  id: string;
  skillsDir: string;
  installedSkills: string[];
  managedSkills?: Record<string, ManagedArtifactState>;
  agentsDir?: string;
  installedAgentFiles?: string[];
  agentFileSources?: Record<string, AgentFileSource>;
  managedAgentFiles?: Record<string, ManagedArtifactState>;
  mcp: McpConfig;
}

export interface ExtensionRecord {
  name: string;
  source: string;
  version: string;
  replacedSkills?: string[];
}

export interface AiFactoryConfig {
  version: string;
  agents: AgentInstallation[];
  extensions?: ExtensionRecord[];
}

interface LegacyAiFactoryConfig {
  version?: string;
  agent?: string;
  skillsDir?: string;
  installedSkills?: string[];
  mcp?: Partial<McpConfig>;
}

interface LegacyAgentInstallationShape {
  id: string;
  skillsDir?: string;
  installedSkills?: string[];
  managedSkills?: unknown;
  agentsDir?: string;
  installedAgentFiles?: string[];
  agentFileSources?: unknown;
  managedAgentFiles?: unknown;
  subagentsDir?: string;
  installedSubagents?: string[];
  managedSubagents?: unknown;
  mcp?: Partial<McpConfig>;
}

const CONFIG_FILENAME = '.ai-factory.json';
const CURRENT_VERSION: string = pkg.version;

function getConfigPath(projectDir: string): string {
  return path.join(projectDir, CONFIG_FILENAME);
}

function normalizeMcp(mcp?: Partial<McpConfig>): McpConfig {
  return {
    github: mcp?.github ?? false,
    filesystem: mcp?.filesystem ?? false,
    postgres: mcp?.postgres ?? false,
    chromeDevtools: mcp?.chromeDevtools ?? false,
    playwright: mcp?.playwright ?? false,
  };
}

function createAgentInstallation(agentId: string, legacy?: LegacyAiFactoryConfig): AgentInstallation {
  const agent = getAgentConfig(agentId);
  return {
    skillsDir: legacy?.skillsDir ?? agent.skillsDir,
    id: agentId,
    installedSkills: legacy?.installedSkills ?? [],
    managedSkills: {},
    agentsDir: agent.agentsDir,
    installedAgentFiles: [],
    agentFileSources: {},
    managedAgentFiles: {},
    mcp: normalizeMcp(legacy?.mcp),
  };
}

function normalizeManagedArtifacts(raw: unknown): Record<string, ManagedArtifactState> {
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const result: Record<string, ManagedArtifactState> = {};

  for (const [skillName, state] of Object.entries(raw as Record<string, unknown>)) {
    if (!skillName || typeof state !== 'object' || !state) {
      continue;
    }

    const sourceHash = (state as { sourceHash?: unknown }).sourceHash;
    const installedHash = (state as { installedHash?: unknown }).installedHash;

    if (typeof sourceHash === 'string' && sourceHash.length > 0 && typeof installedHash === 'string' && installedHash.length > 0) {
      result[skillName] = { sourceHash, installedHash };
    }
  }

  return result;
}

function normalizeAgentFileSources(raw: unknown): Record<string, AgentFileSource> {
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const result: Record<string, AgentFileSource> = {};

  for (const [relPath, source] of Object.entries(raw as Record<string, unknown>)) {
    if (!relPath || typeof source !== 'object' || !source) {
      continue;
    }

    const kind = (source as { kind?: unknown }).kind;
    const sourcePath = (source as { sourcePath?: unknown }).sourcePath;
    const extensionName = (source as { extensionName?: unknown }).extensionName;

    if ((kind !== 'bundled' && kind !== 'extension') || typeof sourcePath !== 'string' || sourcePath.length === 0) {
      continue;
    }

    if (kind === 'extension' && (typeof extensionName !== 'string' || extensionName.length === 0)) {
      continue;
    }

    result[relPath] = {
      kind,
      sourcePath,
      ...(kind === 'extension' ? { extensionName: extensionName as string } : {}),
    };
  }

  return result;
}

let bundledClaudeAgentFilesCache: Set<string> | null = null;

async function getBundledAgentFileTargets(agentId: string): Promise<Set<string>> {
  if (agentId !== 'claude') {
    return new Set<string>();
  }

  if (!bundledClaudeAgentFilesCache) {
    const files = await listFilesRecursive(getSubagentsDir());
    bundledClaudeAgentFilesCache = new Set(
      files.map(filePath => path.relative(getSubagentsDir(), filePath).replaceAll('\\', '/')),
    );
  }

  return bundledClaudeAgentFilesCache;
}

export async function loadConfig(projectDir: string): Promise<AiFactoryConfig | null> {
  const configPath = getConfigPath(projectDir);
  const raw = await readJsonFile<AiFactoryConfig & LegacyAiFactoryConfig>(configPath);
  if (!raw) {
    return null;
  }

  if (Array.isArray(raw.agents)) {
    const extensionSourceIndex = new Map<string, AgentFileSource>();
    const rawExtensions = Array.isArray(raw.extensions) ? raw.extensions : [];
    if (rawExtensions.length > 0) {
      const installedExtensions = await loadAllExtensions(projectDir, rawExtensions.map(extension => extension.name));
      for (const { manifest } of installedExtensions) {
        for (const agentFile of manifest.agentFiles ?? []) {
          extensionSourceIndex.set(`${agentFile.runtime}::${agentFile.target}`, {
            kind: 'extension',
            sourcePath: agentFile.source,
            extensionName: manifest.name,
          });
        }
      }
    }

    const normalizedAgents = raw.agents.map(agent => {
      const legacyAgent = agent as unknown as LegacyAgentInstallationShape;
      const agentConfig = findAgentConfig(agent.id);
      const skillsDir = legacyAgent.skillsDir || agentConfig?.skillsDir;

      if (!skillsDir) {
        throw new Error(
          `Configured agent "${agent.id}" is missing "skillsDir" and no runtime definition is currently registered for it.`,
        );
      }

      const agentsDir = legacyAgent.agentsDir
        || legacyAgent.subagentsDir
        || agentConfig?.agentsDir;
      const installedAgentFiles = Array.isArray(legacyAgent.installedAgentFiles)
        ? legacyAgent.installedAgentFiles
        : Array.isArray(legacyAgent.installedSubagents)
          ? legacyAgent.installedSubagents
          : [];
      const agentFileSources = normalizeAgentFileSources(legacyAgent.agentFileSources);
      const managedAgentFiles = normalizeManagedArtifacts(
        legacyAgent.managedAgentFiles ?? legacyAgent.managedSubagents,
      );

      const filteredAgentFileSources: Record<string, AgentFileSource> = {};
      for (const relPath of installedAgentFiles) {
        const existingSource = agentFileSources[relPath];
        if (existingSource) {
          filteredAgentFileSources[relPath] = existingSource;
          continue;
        }

        const extensionSource = extensionSourceIndex.get(`${agent.id}::${relPath}`);
        if (extensionSource) {
          filteredAgentFileSources[relPath] = extensionSource;
        }
      }

      return {
        id: agent.id,
        skillsDir,
        installedSkills: Array.isArray(legacyAgent.installedSkills) ? legacyAgent.installedSkills : [],
        managedSkills: normalizeManagedArtifacts(legacyAgent.managedSkills),
        agentsDir,
        installedAgentFiles,
        agentFileSources: filteredAgentFileSources,
        managedAgentFiles,
        mcp: normalizeMcp(legacyAgent.mcp),
      };
    });

    for (const agent of normalizedAgents) {
      if (!agent.installedAgentFiles?.length) {
        continue;
      }

      const bundledTargets = await getBundledAgentFileTargets(agent.id);
      for (const relPath of agent.installedAgentFiles) {
        if (!agent.agentFileSources?.[relPath] && bundledTargets.has(relPath)) {
          agent.agentFileSources ??= {};
          agent.agentFileSources[relPath] = {
            kind: 'bundled',
            sourcePath: relPath,
          };
        }
      }
    }

    return {
      version: raw.version ?? CURRENT_VERSION,
      agents: normalizedAgents,
      extensions: rawExtensions,
    };
  }

  if (raw.agent) {
    return {
      version: raw.version ?? CURRENT_VERSION,
      agents: [createAgentInstallation(raw.agent, raw)],
      extensions: [],
    };
  }

  return {
    version: raw.version ?? CURRENT_VERSION,
    agents: [],
    extensions: [],
  };
}

export async function saveConfig(projectDir: string, config: AiFactoryConfig): Promise<void> {
  const configPath = getConfigPath(projectDir);
  await writeJsonFile(configPath, config);
}

export async function configExists(projectDir: string): Promise<boolean> {
  const configPath = getConfigPath(projectDir);
  return fileExists(configPath);
}

export function getCurrentVersion(): string {
  return CURRENT_VERSION;
}
