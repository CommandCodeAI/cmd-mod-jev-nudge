// jev-nudge protocol — the pure half of the jev-nudge mod. Everything here takes
// data and returns data: which endpoint and key to use, what state to show Jev, which
// questions to ask, and how to turn the answers into a stop-hook decision. The mod file
// (index.ts) only wires these onto the ModApi; the client (client.ts) only moves bytes.
//
// Jev is a System One model (typesafe.ai): it answers typed questions about a state with
// probabilities instead of generating text, so the "should the agent keep going?" judgment
// comes back as numbers this file can threshold, with no prose to parse.

import type {AgentMessage} from './types.js';
import {z} from 'zod';

export const JEV_NUDGE_MOD_NAME = 'jev-nudge';

// Jev rides the user's Command Code key through Command Code's provider route, the same one
// `cmd -p … -m typesafe/jev` uses. The key is looked up the way the CLI looks it up:
// CMD_API_KEY first, then COMMAND_CODE_API_KEY (the name the CLI itself reads), then the
// `apiKey` that `cmd login` saved to auth.json.
export const CMD_KEY_ENV = 'CMD_API_KEY';
export const CLI_KEY_ENV = 'COMMAND_CODE_API_KEY';
export const COMMAND_CODE_BASE_URL = 'https://api.commandcode.ai';
export const SYSTEM_ONE_PATH = '/provider/v1/systemone';
export const JEV_MODEL = 'typesafe/jev';

// Measured against the live model, not picked: on this judgment Jev answers 0.5–0.8 when real
// unfinished work remains and 0.04–0.08 once the agent is actually done. The gap is all below
// 0.5, so the cut goes there — 0.6 sat inside the "yes" cluster and made the first nudge a coin
// flip on wording alone.
export const DEFAULT_THRESHOLD = 0.5;
// No count limit by default: a fixed cap stops a run without looking at it, which is exactly
// the "stopped too early" problem this mod exists to fix, one level up. The judgment does the
// limiting — `waiting` vetoes a blocked run and `progress` vetoes a nudge that produced
// nothing, so a run that is genuinely going nowhere stops on evidence rather than on a count.
// `jev-nudge-max=0` still turns nudging off, and the harness keeps its own hard ceiling of 8
// stop-hook continuations per user turn (run.ts), which no mod can raise.
export const DEFAULT_MAX_NUDGES = Number.POSITIVE_INFINITY;
// How much of the transcript rides along. Jev evaluates each question in isolation against
// the whole state, so the state must stay small enough to be a gut check, not a re-read.
const MAX_USER_REQUESTS = 6;
const MAX_TOOL_SUMMARY = 12;
const MAX_TEXT_CHARS = 2_000;

export interface JevConfig {
	readonly apiKey: string;
	readonly baseUrl: string;
	readonly model: string;
}

export interface JevFlags {
	readonly baseUrl?: string;
	readonly model?: string;
}

/**
 * Pick the key and endpoint. The env key wins over the stored login, as it does in the CLI;
 * flags override base URL and model. No key at all means the mod stays dormant —
 * `undefined` here is the whole self-disable.
 */
export function resolveJevConfig(params: {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly storedKey?: string;
	readonly flags?: JevFlags;
}): JevConfig | undefined {
	const apiKey =
		nonEmpty(params.env[CMD_KEY_ENV]) ??
		nonEmpty(params.env[CLI_KEY_ENV]) ??
		nonEmpty(params.storedKey);
	if (!apiKey) return undefined;
	const baseUrl = nonEmpty(params.flags?.baseUrl) ?? COMMAND_CODE_BASE_URL;
	const model = nonEmpty(params.flags?.model) ?? JEV_MODEL;
	return {apiKey, baseUrl: stripTrailingSlashes(baseUrl), model};
}

function nonEmpty(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (trimmed === '') return undefined;
	return trimmed;
}

function stripTrailingSlashes(url: string): string {
	return url.replace(/\/+$/, '');
}

// ── State ──────────────────────────────────────────────────────────────────

/**
 * One earlier nudge this run: the reply it fired on, and how much work followed it.
 *
 * The text stored is the message the agent stopped on *when it was nudged*, not the one it
 * stopped on afterwards — that later message is already `latest_assistant_message`, and
 * putting it here too made the progress guard compare a message against itself and answer
 * "no progress" every time.
 */
export interface PreviousNudge {
	readonly turnNumber: number;
	readonly toolCallsAfter: number;
	readonly assistantTextAtNudge: string;
}

export interface NudgeState {
	readonly [key: string]: unknown;
	readonly user_requests: readonly string[];
	readonly latest_assistant_message: string;
	readonly recent_tool_calls: readonly string[];
	readonly turn_number: number;
	// Omitted entirely when nothing has been nudged yet: an empty list is not evidence, and
	// sending one measurably talks the model down (~7 points) on the very first stop.
	readonly previous_nudges?: readonly {
		readonly turn_number: number;
		readonly tool_calls_after: number;
		readonly assistant_text_at_nudge: string;
	}[];
}

/**
 * Compress the transcript into the fields the questions reference: what the user asked for
 * (every typed request, so work carried forward from earlier turns is visible), the reply
 * the agent is about to stop on, the recent tool activity, and any earlier nudges with what
 * followed them. Automated turns (skills, meta, earlier nudges) are not user requests.
 */
export function buildNudgeState(params: {
	readonly messages: readonly AgentMessage[];
	readonly lastAssistantText: string;
	readonly turnNumber: number;
	readonly previousNudges: readonly PreviousNudge[];
}): NudgeState {
	const userRequests = params.messages
		.filter(isTypedUserMessage)
		.map(messageText)
		.filter(text => text !== '')
		.slice(-MAX_USER_REQUESTS)
		.map(text => clip(text));
	const toolCalls: string[] = [];
	for (const message of params.messages) {
		if (message.role !== 'assistant') continue;
		for (const block of message.content) {
			if (block.type !== 'tool_use') continue;
			toolCalls.push(block.name);
		}
	}
	return {
		user_requests: userRequests,
		latest_assistant_message: clip(params.lastAssistantText),
		recent_tool_calls: toolCalls.slice(-MAX_TOOL_SUMMARY),
		turn_number: params.turnNumber,
		...(params.previousNudges.length > 0
			? {
					previous_nudges: params.previousNudges.map(nudge => ({
						turn_number: nudge.turnNumber,
						tool_calls_after: nudge.toolCallsAfter,
						assistant_text_at_nudge: clip(nudge.assistantTextAtNudge),
					})),
				}
			: {}),
	};
}

function isTypedUserMessage(message: AgentMessage): boolean {
	if (message.role !== 'user') return false;
	if (message.meta?.isAutomated || message.meta?.isMeta) return false;
	const source = message.meta?.source;
	if (source && source !== 'user') return false;
	// Tool-result carriers are the loop talking to itself, not the user.
	return message.content.some(block => block.type === 'text');
}

function messageText(message: AgentMessage): string {
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type !== 'text') continue;
		parts.push(block.text);
	}
	return parts.join('\n').trim();
}

function clip(text: string): string {
	if (text.length <= MAX_TEXT_CHARS) return text;
	return `${text.slice(0, MAX_TEXT_CHARS)}…`;
}

// ── Questions ──────────────────────────────────────────────────────────────

// The judgment, in the words the mod was asked to encode (Will Brown's stop hook prompt).
// Sent as one question so its clauses weigh together; the two guards below split out the
// dimensions the code wants to threshold on their own.
export const NUDGE_INSTRUCTIONS = [
	'Would a gentle nudge help the agent advance useful work within the user’s existing request right now?',
	'Consider unfinished work, including requests carried forward from earlier turns (`user_requests`). Answering the latest message doesn’t necessarily finish the request.',
	'If the work is complete, the user is still choosing a direction, or progress requires permission, information, or an external event, don’t nudge.',
	'If there was a previous nudge (`previous_nudges`), consider what happened afterward. Further useful progress can justify another nudge; repeating the same promise or an already-explained blocker does not.',
].join('\n\n');

export const WAITING_INSTRUCTIONS =
	'Is the agent stopped because the next step needs something only the user or the outside world can supply: a permission, a decision between directions, missing information, or an external event?';

export const PROGRESS_INSTRUCTIONS =
	'The last entry in `previous_nudges` holds `assistant_text_at_nudge`, what the agent said when it was nudged, and `tool_calls_after`, how many tools it ran since. Compare that with `latest_assistant_message` and `recent_tool_calls`: has the agent moved on to further useful work, rather than repeating the same promise or the same already-explained blocker?';

/** A yes/no question; System One calls the type `noul` and answers it with a probability. */
export interface NoulQuestion {
	readonly type: 'noul';
	readonly instructions: string;
	readonly criteria?: {readonly true?: string; readonly false?: string};
}

export interface NudgeQuestions {
	readonly nudge: NoulQuestion;
	readonly waiting: NoulQuestion;
	readonly progress?: NoulQuestion;
}

export function nudgeQuestions(params: {
	readonly hasPreviousNudge: boolean;
}): NudgeQuestions {
	const type = 'noul';
	const base: NudgeQuestions = {
		nudge: {
			type,
			instructions: NUDGE_INSTRUCTIONS,
			criteria: {
				true: 'Unfinished, unblocked work remains inside the user’s request and a nudge would move it forward.',
				false:
					'The work is done, the user must decide or supply something first, or a nudge would only repeat itself.',
			},
		},
		waiting: {
			type,
			instructions: WAITING_INSTRUCTIONS,
		},
	};
	if (!params.hasPreviousNudge) return base;
	return {...base, progress: {type, instructions: PROGRESS_INSTRUCTIONS}};
}

// ── Answers ────────────────────────────────────────────────────────────────

/** The three probabilities, lifted out of their `{type, noul}` answers. */
export interface NudgeAnswers {
	readonly nudge: number;
	readonly waiting: number;
	readonly progress?: number;
}

// System One returns `{model, answers, usage}` with each yes/no answered as `{type: 'noul',
// noul}`; the schema hands back plain numbers so nothing downstream sees the wire shape.
const probability = z.object({noul: z.number()}).transform(answer => answer.noul);

export const jevResponseSchema = z.object({
	model: z.string().optional(),
	answers: z.object({
		nudge: probability,
		waiting: probability,
		progress: probability.optional(),
	}),
});

export interface NudgeDecision {
	readonly nudge: boolean;
	readonly probability: number;
	readonly why: string;
}

/**
 * Turn probabilities into the hook's yes/no. The main question carries the judgment; the
 * guards can only veto it — a blocked run is never nudged however promising the work looks,
 * and a second nudge needs evidence the first one produced progress.
 */
export function decideNudge(params: {
	readonly answers: NudgeAnswers;
	readonly threshold: number;
}): NudgeDecision {
	const {answers, threshold} = params;
	const probability = answers.nudge;
	if (answers.waiting >= 0.5) {
		return {
			nudge: false,
			probability,
			why: `waiting on the user (${percent(answers.waiting)})`,
		};
	}
	if (answers.progress !== undefined && answers.progress < 0.5) {
		return {
			nudge: false,
			probability,
			why: `no progress since the last nudge (${percent(answers.progress)})`,
		};
	}
	if (probability < threshold) {
		return {
			nudge: false,
			probability,
			why: `below threshold (${percent(probability)} < ${percent(threshold)})`,
		};
	}
	return {nudge: true, probability, why: `nudge ${percent(probability)}`};
}

function percent(value: number): string {
	return `${Math.round(value * 100)}%`;
}

/** The automated user turn the loop appends when the hook says continue. */
export const NUDGE_REASON =
	'Gentle nudge: the user’s request still has unfinished work you can advance right now. Pick up the next useful step and keep going. If you are actually done, or the next step needs the user’s permission, a decision, or information only they have, say so in one line and stop.';

/** Parse a `jev-nudge-threshold` flag; anything unusable falls back to the default. */
export function parseThreshold(value: string | boolean | undefined): number {
	if (typeof value !== 'string') return DEFAULT_THRESHOLD;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1)
		return DEFAULT_THRESHOLD;
	return parsed;
}

/**
 * Parse a `jev-nudge-max` flag; anything unusable falls back to the default (no limit). Only a
 * finite, non-negative whole number caps the count — `0` turns nudging off entirely.
 */
export function parseMaxNudges(value: string | boolean | undefined): number {
	if (typeof value !== 'string') return DEFAULT_MAX_NUDGES;
	const parsed = Number(value.trim());
	if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_MAX_NUDGES;
	return parsed;
}
