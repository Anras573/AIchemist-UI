import { z } from "zod";

export const ApprovalRuleSchema = z.object({
  tool_category: z.enum(["filesystem", "shell", "web", "custom"]),
  policy: z.enum(["always", "never", "risky_only"]),
});

export const AllowedToolSchema = z.object({
  tool_name: z.string(),
  command_pattern: z.string().optional(),
});

export const ToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  category: z.string(),
  parameters: z.record(z.string(), z.unknown()).default({}),
  requires_approval: z.union([z.boolean(), z.literal("inherit")]).default("inherit"),
});

export const ProjectConfigSchema = z.object({
  provider: z.enum(["anthropic", "copilot", "ollama"]).default("anthropic"),
  model: z.string().default(""),
  approval_mode: z.enum(["all", "none", "custom"]).default("custom"),
  approval_rules: z.array(ApprovalRuleSchema).default([]),
  custom_tools: z.array(ToolDefinitionSchema).default([]),
  allowed_tools: z.array(AllowedToolSchema).default([]),
  create_worktree_per_session: z.boolean().default(false),
  worktree_root_path: z.string().optional(),
});

// Types derived from schemas
export type ApprovalRule = z.infer<typeof ApprovalRuleSchema>;
export type AllowedTool = z.infer<typeof AllowedToolSchema>;
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
