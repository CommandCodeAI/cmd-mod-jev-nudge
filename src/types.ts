// The slice of Command Code's mod surface this package touches, declared locally.
//
// `@commandcode/harness` (the package that owns `ModApi`) is not published to npm, and the
// `command-code` CLI ships no type declarations, so a standalone mod cannot import the types.
// At runtime none of this matters: Command Code loads `src/index.ts` with jiti, type imports
// are erased, and the real `ModApi` object is passed in. These declarations mirror the
// harness's `packages/harness/src/mod-host/types.ts` and `core/types.ts` for the members
// used here; keep them in step when the upstream surface changes.

export type TextBlock = {readonly type: 'text'; readonly text: string};
export type ToolUseBlock = {
	readonly type: 'tool_use';
	readonly id: string;
	readonly name: string;
	readonly input: Record<string, unknown>;
};
export type ToolResultBlock = {
	readonly type: 'tool_result';
	readonly tool_use_id: string;
	readonly content: readonly unknown[];
};
export type OtherBlock = {
	readonly type: 'image' | 'thinking' | 'server_tool_result';
};

export interface MessageMeta {
	readonly isMeta?: boolean;
	readonly isAutomated?: boolean;
	readonly source?: string;
}

export type AgentMessage =
	| {
			readonly role: 'user';
			readonly content: readonly (TextBlock | ToolResultBlock | OtherBlock)[];
			readonly meta?: MessageMeta;
	  }
	| {
			readonly role: 'assistant';
			readonly content: readonly (TextBlock | ToolUseBlock | OtherBlock)[];
			readonly meta?: MessageMeta;
	  };

export interface AgentState {
	readonly sessionId: string;
	readonly messages: readonly AgentMessage[];
	readonly interrupted: boolean;
	readonly modState: Readonly<Record<string, unknown>>;
}

export interface ModContext {
	readonly signal: AbortSignal;
	readonly cwd: string;
}

export interface StopHookParams {
	readonly state: AgentState;
	readonly stopReason: 'end_turn' | 'max_tokens';
	readonly turnNumber: number;
	readonly lastAssistantText: string;
}

export interface StopHookResult {
	readonly continue?: boolean;
	readonly reason?: string;
}

export interface AfterToolCallParams {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly input: Record<string, unknown>;
	readonly result: readonly unknown[];
	readonly isError: boolean;
	readonly state: AgentState;
}

/** The hooks this mod registers; the real `ModHooks` has many more, all optional. */
export interface ModHooks {
	onTurnStart?(
		params: {readonly state: AgentState; readonly turnNumber: number},
		ctx?: ModContext,
	): Promise<AgentState>;
	afterToolCall?(
		params: AfterToolCallParams,
		ctx?: ModContext,
	): Promise<{readonly additionalContext?: string} | undefined>;
	onStop?(
		params: StopHookParams,
		ctx?: ModContext,
	): Promise<StopHookResult | undefined>;
}

export interface ModFlagDefinition {
	readonly description?: string;
	readonly type: 'boolean' | 'string';
	readonly default?: boolean | string;
}

export interface Disposable {
	dispose(): void;
}

/** The members of Command Code's `ModApi` this mod calls. */
export interface ModApi {
	readonly name: string;
	readonly ui: {
		notify(message: string, level?: 'info' | 'warning'): void;
	};
	hooks(hooks: ModHooks): Disposable;
	addFlag(name: string, definition: ModFlagDefinition): Disposable;
	getFlag(name: string): boolean | string | undefined;
}
