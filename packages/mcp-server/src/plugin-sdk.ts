import type { McpToolDefinition } from './tools/tool-types.js';

export interface LnwjudPluginPermission {
  readonly name: string;
  readonly reason: string;
}

export interface LnwjudSkillDescriptor {
  readonly id: string;
  readonly description: string;
  readonly tags: readonly string[];
}

export interface LnwjudRecipeDescriptor {
  readonly name: string;
  readonly steps: readonly string[];
}

export interface LnwjudPlugin {
  readonly id: string;
  readonly version: string;
  readonly tools?: readonly McpToolDefinition[];
  readonly hooks?: readonly string[];
  readonly skills?: readonly LnwjudSkillDescriptor[];
  readonly recipes?: readonly LnwjudRecipeDescriptor[];
  readonly requiredPermissions?: readonly LnwjudPluginPermission[];
}
