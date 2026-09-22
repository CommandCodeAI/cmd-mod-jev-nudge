// jev-nudge client — one POST to Command Code's System One provider route, authorized with
// the user's own Command Code key. A direct fetch rather than spawning `cmd -p … -m
// typesafe/jev`: the stop hook sits between "model finished" and "prompt comes back", and a
// second CLI process would add its boot time, load this very mod again, and hand back text to
// parse instead of JSON.

import type {
	JevConfig,
	NudgeAnswers,
	NudgeQuestions,
	NudgeState,
} from './protocol.js';
import {jevResponseSchema, SYSTEM_ONE_PATH} from './protocol.js';

export type JevFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface AskJevParams {
	readonly config: JevConfig;
	readonly state: NudgeState;
	readonly questions: NudgeQuestions;
	readonly fetch: JevFetch;
	readonly timeoutMs: number;
	readonly signal?: AbortSignal;
}

export interface AskJevResult {
	readonly answers: NudgeAnswers;
	readonly model: string | undefined;
}

/** Ask Jev the nudge questions. Throws on transport, HTTP, or shape failures. */
export async function askJev(params: AskJevParams): Promise<AskJevResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), params.timeoutMs);
	timer.unref?.();
	const abort = (): void => controller.abort();
	params.signal?.addEventListener('abort', abort, {once: true});
	try {
		const response = await params.fetch(
			`${params.config.baseUrl}${SYSTEM_ONE_PATH}`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${params.config.apiKey}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					model: params.config.model,
					state: params.state,
					questions: params.questions,
				}),
				signal: controller.signal,
			},
		);
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(
				`jev ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
			);
		}
		const parsed = jevResponseSchema.safeParse(
			await response.json(),
		);
		if (!parsed.success) {
			throw new Error(
				`jev returned an unexpected shape: ${parsed.error.message}`,
			);
		}
		return {answers: parsed.data.answers, model: parsed.data.model};
	} finally {
		clearTimeout(timer);
		params.signal?.removeEventListener('abort', abort);
	}
}
