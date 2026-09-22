// jev-nudge mod — the "agent stopped too early" fix from Will Brown's stop hook,
// as a Command Code Stop hook backed by Jev (typesafe.ai's System One model) through
// Command Code's own provider, on the key the user already signed in with.
//
// When a run would end naturally, the hook shows Jev a compressed view of the session (what
// the user asked for across every turn, the reply the agent is stopping on, recent tool
// calls, earlier nudges and what followed them) and asks: would a gentle nudge help the
// agent advance useful work within the user's existing request right now? Jev answers with
// a probability, not prose, so the decision is a threshold, and two guard questions veto a
// nudge when the run is waiting on the user or when the last nudge produced no progress.
//
// Dormant without a key: it reads CMD_API_KEY or COMMAND_CODE_API_KEY, else the `apiKey`
// `cmd login` saved to ~/.commandcode/auth.json, at factory time and registers nothing but
// its flags when none is there. A failing or slow Jev call never changes the stop — the run
// ends exactly as it would have without the mod.
//
// Standalone package: only TYPES come from @commandcode/harness, so the file loads under
// jiti from any install location without resolving the harness at runtime. Decisions are
// logged to stderr when DEBUG=true (the harness's own debug log is not reachable from here).

import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import type {ModApi} from './types.js';
import {askJev, type JevFetch} from './client.js';
import {
	buildNudgeState,
	DEFAULT_THRESHOLD,
	decideNudge,
	JEV_NUDGE_MOD_NAME,
	NUDGE_REASON,
	nudgeQuestions,
	parseMaxNudges,
	parseThreshold,
	type PreviousNudge,
	resolveJevConfig,
	CMD_KEY_ENV,
} from './protocol.js';

// A stop decision is on the critical path between "model finished" and "prompt comes back";
// a gut-check model should answer well inside this, and past it the run just stops.
const JEV_TIMEOUT_MS = 8_000;

export interface JevNudgeModOptions {
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly fetch?: JevFetch;
	/** The key saved by `cmd login`; defaults to reading ~/.commandcode/auth.json. */
	readonly storedKey?: () => string | undefined;
}

interface RunBookkeeping {
	readonly nudges: readonly PreviousNudge[];
	readonly toolCallsSinceNudge: number;
}

const FRESH_RUN: RunBookkeeping = {nudges: [], toolCallsSinceNudge: 0};

export function createJevNudgeMod(
	options: JevNudgeModOptions = {},
): (cmd: ModApi) => void {
	const env = options.env ?? process.env;
	const fetchImpl: JevFetch =
		options.fetch ?? ((input, init) => globalThis.fetch(input, init));
	const storedKey = (options.storedKey ?? readStoredKey)();

	return (cmd: ModApi): void => {
		cmd.addFlag('jev-nudge-threshold', {
			type: 'string',
			default: String(DEFAULT_THRESHOLD),
			description:
				'Minimum probability (0–1) Jev must give "a nudge would help" before the run is continued',
		});
		cmd.addFlag('jev-nudge-max', {
			type: 'string',
			description:
				'Cap the nudges per run (0 disables nudging). Unset, there is no count limit — the waiting and progress guards decide when to stop.',
		});
		cmd.addFlag('jev-nudge-base-url', {
			type: 'string',
			description:
				'API root for Jev (default: https://api.commandcode.ai)',
		});
		cmd.addFlag('jev-nudge-model', {
			type: 'string',
			description:
				'Model id sent to the endpoint (default: typesafe/jev)',
		});

		cmd.addFlag('jev-nudge-verbose', {
			type: 'boolean',
			default: false,
			description:
				'Show every stop decision as a feed row, not only the nudges (for trying the mod out)',
		});

		// Flags are applied after every factory has run (setFlagValue), so the endpoint is
		// resolved lazily at the first stop — only the key check happens here. A user who
		// loaded this mod on purpose deserves to hear why it does nothing.
		if (!resolveJevConfig({env, storedKey})) {
			cmd.ui.notify(
				`${JEV_NUDGE_MOD_NAME}: no Command Code key (run \`cmd login\` or set ${CMD_KEY_ENV}), nudging is off`,
				'warning',
			);
			return;
		}

		let run: RunBookkeeping = FRESH_RUN;
		const verbose = (): boolean => cmd.getFlag('jev-nudge-verbose') === true;

		cmd.hooks({
			onTurnStart: async ({state, turnNumber}) => {
				if (turnNumber === 1) run = FRESH_RUN;
				return state;
			},
			afterToolCall: async () => {
				run = {
					...run,
					toolCallsSinceNudge: run.toolCallsSinceNudge + 1,
				};
				return undefined;
			},
			onStop: async (
				{state, stopReason, turnNumber, lastAssistantText},
				ctx,
			) => {
				if (stopReason !== 'end_turn') return undefined;
				const config = resolveJevConfig({
					env,
					storedKey,
					flags: {
						baseUrl: stringFlag(cmd.getFlag('jev-nudge-base-url')),
						model: stringFlag(cmd.getFlag('jev-nudge-model')),
					},
				});
				if (!config) return undefined;
				const maxNudges = parseMaxNudges(cmd.getFlag('jev-nudge-max'));
				if (run.nudges.length >= maxNudges) return undefined;
				const threshold = parseThreshold(cmd.getFlag('jev-nudge-threshold'));

				const previousNudges = withOutcome({
					nudges: run.nudges,
					toolCallsSinceNudge: run.toolCallsSinceNudge,
				});
				const nudgeState = buildNudgeState({
					messages: state.messages,
					lastAssistantText,
					turnNumber,
					previousNudges,
				});

				let decision: ReturnType<typeof decideNudge>;
				try {
					const asked = await askJev({
						config,
						state: nudgeState,
						questions: nudgeQuestions({
							hasPreviousNudge: previousNudges.length > 0,
						}),
						fetch: fetchImpl,
						timeoutMs: JEV_TIMEOUT_MS,
						...(ctx?.signal ? {signal: ctx.signal} : {}),
					});
					decision = decideNudge({answers: asked.answers, threshold});
				} catch (error) {
					// Best-effort: the stop decision must never depend on a network call succeeding,
					// but a failing call is said out loud so "no nudge" is never a mystery.
					const message = error instanceof Error ? error.message : String(error);
					dlog(`[${JEV_NUDGE_MOD_NAME}] ${message}`);
					cmd.ui.notify(
						`${JEV_NUDGE_MOD_NAME}: Jev call failed (${message}), letting the run stop`,
						'warning',
					);
					return undefined;
				}

				dlog(`[${JEV_NUDGE_MOD_NAME}] turn ${turnNumber}: ${decision.why}`);
				if (!decision.nudge) {
					if (verbose())
						cmd.ui.notify(
							`${JEV_NUDGE_MOD_NAME}: turn ${turnNumber}, no nudge (${decision.why})`,
						);
					return undefined;
				}

				run = {
					nudges: [
						...previousNudges,
						{turnNumber, toolCallsAfter: 0, assistantTextAtNudge: lastAssistantText},
					],
					toolCallsSinceNudge: 0,
				};
				// "3/5" when a cap is set, plain "3" when the count is unlimited.
				const counted = Number.isFinite(maxNudges)
					? `${run.nudges.length}/${maxNudges}`
					: `${run.nudges.length}`;
				cmd.ui.notify(
					`jev nudge ${counted}: unfinished work found (${Math.round(decision.probability * 100)}%), continuing`,
				);
				return {continue: true, reason: NUDGE_REASON};
			},
		});
	};
}

/**
 * Fill in how much work followed the most recent nudge, now that this stop shows it. Only the
 * tool count is filled in here; the nudge's text is the reply it fired on and was recorded
 * when it fired, so the progress guard has an earlier message to compare this stop against.
 */
function withOutcome(params: {
	readonly nudges: readonly PreviousNudge[];
	readonly toolCallsSinceNudge: number;
}): readonly PreviousNudge[] {
	const last = params.nudges.at(-1);
	if (!last) return params.nudges;
	return [
		...params.nudges.slice(0, -1),
		{...last, toolCallsAfter: params.toolCallsSinceNudge},
	];
}

function stringFlag(value: string | boolean | undefined): string | undefined {
	if (typeof value !== 'string') return undefined;
	return value;
}

/** The `apiKey` from ~/.commandcode/auth.json, where `cmd login` keeps it. */
function readStoredKey(): string | undefined {
	try {
		const auth: unknown = JSON.parse(
			readFileSync(join(homedir(), '.commandcode', 'auth.json'), 'utf8'),
		);
		if (typeof auth !== 'object' || auth === null) return undefined;
		const {apiKey} = auth as {apiKey?: unknown};
		return typeof apiKey === 'string' ? apiKey : undefined;
	} catch {
		return undefined;
	}
}

function dlog(message: string): void {
	if (process.env.DEBUG !== 'true') return;
	process.stderr.write(`${message}\n`);
}

/** The factory Command Code loads from this package (see package.json "commandcode.mods"). */
export default createJevNudgeMod();
