// jev-nudge protocol tests — the pure half: key resolution, the state Jev sees, the
// questions asked, and how probabilities become a stop-hook decision.

import type {AgentMessage} from '../types.js';
import {describe, expect, it} from 'vitest';
import {
	buildNudgeState,
	DEFAULT_MAX_NUDGES,
	DEFAULT_THRESHOLD,
	decideNudge,
	COMMAND_CODE_BASE_URL,
	jevResponseSchema,
	nudgeQuestions,
	parseMaxNudges,
	parseThreshold,
	JEV_MODEL,
	resolveJevConfig,
} from '../protocol.js';

describe('resolveJevConfig', () => {
	it('is dormant without a key', () => {
		expect(resolveJevConfig({env: {}})).toBeUndefined();
		expect(
			resolveJevConfig({env: {CMD_API_KEY: '   '}, storedKey: ''}),
		).toBeUndefined();
	});

	it('prefers CMD_API_KEY, then COMMAND_CODE_API_KEY, then the stored login', () => {
		expect(
			resolveJevConfig({
				env: {CMD_API_KEY: 'env', COMMAND_CODE_API_KEY: 'cli'},
				storedKey: 'stored',
			}),
		).toEqual({
			apiKey: 'env',
			baseUrl: COMMAND_CODE_BASE_URL,
			model: JEV_MODEL,
		});
		expect(
			resolveJevConfig({env: {COMMAND_CODE_API_KEY: 'cli'}, storedKey: 'stored'})
				?.apiKey,
		).toBe('cli');
		expect(resolveJevConfig({env: {}, storedKey: 'stored'})?.apiKey).toBe(
			'stored',
		);
	});

	it('lets flags override base URL and model, trimming trailing slashes', () => {
		expect(
			resolveJevConfig({
				env: {CMD_API_KEY: 'ck'},
				flags: {baseUrl: 'https://proxy.example/v1/', model: 'jev-2'},
			}),
		).toMatchObject({baseUrl: 'https://proxy.example/v1', model: 'jev-2'});
	});
});

const user = (text: string, meta?: AgentMessage['meta']): AgentMessage => ({
	role: 'user',
	content: [{type: 'text', text}],
	...(meta ? {meta} : {}),
});

describe('buildNudgeState', () => {
	it('keeps typed user requests and drops automated, meta, and tool-result turns', () => {
		const messages: readonly AgentMessage[] = [
			user('add tests and update the docs'),
			{
				role: 'assistant',
				content: [
					{type: 'text', text: 'On it.'},
					{type: 'tool_use', id: 't1', name: 'write_file', input: {}},
				],
			},
			{
				role: 'user',
				content: [{type: 'tool_result', tool_use_id: 't1', content: []}],
			},
			user('keep going', {isAutomated: true, source: 'stop_hook'}),
			user('skill body', {isMeta: true, source: 'skill'}),
			user('also bump the version'),
		];
		const state = buildNudgeState({
			messages,
			lastAssistantText: 'Tests added. I will update the docs next.',
			turnNumber: 4,
			previousNudges: [
				{
					turnNumber: 2,
					toolCallsAfter: 3,
					assistantTextAtNudge: 'wrote tests',
				},
			],
		});
		expect(state.user_requests).toEqual([
			'add tests and update the docs',
			'also bump the version',
		]);
		expect(state.recent_tool_calls).toEqual(['write_file']);
		expect(state.turn_number).toBe(4);
		expect(state.previous_nudges).toEqual([
			{
				turn_number: 2,
				tool_calls_after: 3,
				assistant_text_at_nudge: 'wrote tests',
			},
		]);
	});

	it('omits previous_nudges entirely until something has been nudged', () => {
		// An empty list is not evidence, and sending one measurably lowers Jev's answer.
		const state = buildNudgeState({
			messages: [user('do the thing')],
			lastAssistantText: 'Started.',
			turnNumber: 1,
			previousNudges: [],
		});
		expect('previous_nudges' in state).toBe(false);
	});

	it('clips long text so the state stays a gut check', () => {
		const state = buildNudgeState({
			messages: [user('x'.repeat(5_000))],
			lastAssistantText: 'y'.repeat(5_000),
			turnNumber: 1,
			previousNudges: [],
		});
		expect(state.user_requests[0]?.length).toBeLessThan(2_100);
		expect(state.latest_assistant_message.length).toBeLessThan(2_100);
	});
});

describe('nudgeQuestions', () => {
	it('asks the progress guard only once a nudge already happened', () => {
		expect(
			Object.keys(
				nudgeQuestions({hasPreviousNudge: false}),
			),
		).toEqual(['nudge', 'waiting']);
		expect(
			Object.keys(
				nudgeQuestions({hasPreviousNudge: true}),
			),
		).toEqual(['nudge', 'waiting', 'progress']);
		expect(
			nudgeQuestions({hasPreviousNudge: false}).nudge
				.instructions,
		).toContain('gentle nudge');
	});

	it('asks every question as a System One `noul`', () => {
		const questions = nudgeQuestions({hasPreviousNudge: true});
		expect([
			questions.nudge.type,
			questions.waiting.type,
			questions.progress?.type,
		]).toEqual(['noul', 'noul', 'noul']);
	});
});

describe('decideNudge', () => {
	const answers = (
		nudge: number,
		waiting: number,
		progress?: number,
	): Parameters<typeof decideNudge>[0]['answers'] => ({
		nudge,
		waiting,
		...(progress === undefined ? {} : {progress}),
	});

	it('nudges when Jev is confident and nothing vetoes', () => {
		expect(
			decideNudge({answers: answers(0.9, 0.1), threshold: 0.6}),
		).toMatchObject({nudge: true, probability: 0.9});
	});

	it('never nudges a run that is waiting on the user', () => {
		const decision = decideNudge({
			answers: answers(0.95, 0.8),
			threshold: 0.6,
		});
		expect(decision.nudge).toBe(false);
		expect(decision.why).toContain('waiting');
	});

	it('never repeats a nudge that produced no progress', () => {
		const decision = decideNudge({
			answers: answers(0.9, 0.1, 0.2),
			threshold: 0.6,
		});
		expect(decision.nudge).toBe(false);
		expect(decision.why).toContain('no progress');
	});

	it('respects the threshold', () => {
		expect(
			decideNudge({answers: answers(0.55, 0.1), threshold: 0.6}).nudge,
		).toBe(false);
		expect(
			decideNudge({answers: answers(0.6, 0.1), threshold: 0.6}).nudge,
		).toBe(true);
	});
});

describe('flag parsing', () => {
	it('falls back to defaults on unusable values', () => {
		expect(parseThreshold(undefined)).toBe(DEFAULT_THRESHOLD);
		expect(parseThreshold('abc')).toBe(DEFAULT_THRESHOLD);
		expect(parseThreshold('1.5')).toBe(DEFAULT_THRESHOLD);
		expect(parseThreshold('0.8')).toBe(0.8);
		expect(parseMaxNudges(true)).toBe(DEFAULT_MAX_NUDGES);
		expect(parseMaxNudges('-1')).toBe(DEFAULT_MAX_NUDGES);
		expect(parseMaxNudges('2.5')).toBe(DEFAULT_MAX_NUDGES);
		expect(parseMaxNudges('0')).toBe(0);
		expect(parseMaxNudges('6')).toBe(6);
	});

	it('does not cap the nudge count unless asked to', () => {
		// The guards do the limiting; a count is opt-in.
		expect(DEFAULT_MAX_NUDGES).toBe(Number.POSITIVE_INFINITY);
		expect(parseMaxNudges(undefined)).toBe(Number.POSITIVE_INFINITY);
	});
});

describe('jevResponseSchema', () => {
	it('lifts the `noul` probabilities and rejects a missing answer', () => {
		const parsed = jevResponseSchema.safeParse({
			model: 'typesafe/jev',
			answers: {
				nudge: {type: 'noul', noul: 0.89},
				waiting: {type: 'noul', noul: 0.18},
			},
			usage: {input_tokens: 322, output_tokens: 37},
		});
		expect(parsed.success && parsed.data.answers).toEqual({
			nudge: 0.89,
			waiting: 0.18,
		});
		expect(
			jevResponseSchema.safeParse({
				answers: {nudge: {type: 'noul', noul: 0.7}},
			}).success,
		).toBe(false);
	});
});
