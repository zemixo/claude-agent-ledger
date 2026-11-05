// Known model ids — kept narrow for documentation. Use `string` at the boundary.
export const KNOWN_MODELS = [
	'claude-opus-4-7',
	'claude-sonnet-4-6',
	'claude-haiku-4-5-20251001',
	'claude-opus-4-6',
	'claude-opus-4-5',
	'claude-sonnet-4-5',
	'claude-haiku-4-0',
] as const;

export type ModelId = string;

export type TurnType = 'user' | 'assistant' | 'summary' | 'system';

export interface CacheCreationDetail {
	ephemeral_5m_input_tokens?: number;
	ephemeral_1h_input_tokens?: number;
}

export interface ServerToolUse {
	web_search_requests?: number;
	web_fetch_requests?: number;
}

export interface TokenUsage {
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation?: CacheCreationDetail;
	server_tool_use?: ServerToolUse;
}

export interface SessionTurn {
	type: TurnType;
	timestamp: string;
	sessionId: string;
	projectId?: string | undefined;
	subagentType?: string | undefined;
	parentSessionId?: string | undefined;
	model?: ModelId | undefined;
	usage?: TokenUsage | undefined;
	toolUses?: string[] | undefined; // tool names invoked in this assistant turn
}

export interface CostBreakdown {
	inputCost: number;
	outputCost: number;
	cacheCreation5mCost: number;
	cacheCreation1hCost: number;
	cacheReadCost: number;
	serverToolUseCost: number;
	totalCost: number;
}

export interface AggregatedRow {
	subagent: string;
	sessionCount: number;
	inputTokens: number;
	outputTokens: number;
	cacheCreation5mTokens: number;
	cacheCreation1hTokens: number;
	cacheReadTokens: number;
	webSearchRequests: number;
	webFetchRequests: number;
	cost: CostBreakdown;
}

export interface LedgerReport {
	period: { from: Date; to: Date };
	rows: AggregatedRow[];
	total: AggregatedRow;
}

// Subagent-graph node — the MOAT feature.
// Represents one parent session's tree-rooted cost attribution:
// the parent's own cost + all child subagent costs, recursively.
export interface SubagentTreeNode {
	sessionId: string;
	label: string; // subagentType or '(orchestrator)'
	selfCost: number;
	totalCost: number; // self + children
	children: SubagentTreeNode[];
	turnCount: number;
}
