import type { McpToolDefinition } from './tools/tool-types.js';

export interface UnifiedMpcPluginPermission {
  readonly name: string;
  readonly reason: string;
}

export interface UnifiedMpcSkillDescriptor {
  readonly id: string;
  readonly description: string;
  readonly tags: readonly string[];
}

export interface UnifiedMpcRecipeDescriptor {
  readonly name: string;
  readonly steps: readonly string[];
}

export interface UnifiedMpcPlugin {
  readonly id: string;
  readonly version: string;
  readonly tools?: readonly McpToolDefinition[];
  readonly hooks?: readonly string[];
  readonly skills?: readonly UnifiedMpcSkillDescriptor[];
  readonly recipes?: readonly UnifiedMpcRecipeDescriptor[];
  readonly requiredPermissions?: readonly UnifiedMpcPluginPermission[];
}
