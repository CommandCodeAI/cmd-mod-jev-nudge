// Local stand-in for Jev, for trying the mod offline. Serves Command Code's POST
// /provider/v1/systemone and answers with fixed rules instead of a model: nudge 86% unless the reply
// says the work is done, waiting 92% when the reply ends with a question, progress 90% when
// tools ran since the last nudge. Every request is appended to jev-log.jsonl so you can see
// exactly what the mod sent.
//
//   node scripts/fake-jev.mjs
//   CMD_API_KEY=x DEBUG=true cmd --mod . --mod-option jev-nudge-base-url=http://127.0.0.1:4711
import {createServer} from 'node:http';
import {appendFileSync} from 'node:fs';

const judge = state => {
	const text = String(state.latest_assistant_message ?? '');
	const waiting = /\?\s*$/.test(text) ? 0.92 : 0.06;
	const finished = /\b(all done|everything is done|all (three|five|the) (files|steps) are done|nothing (else|more) to do)\b/i.test(text);
	const nudge = finished ? 0.08 : 0.86;
	const last = state.previous_nudges?.at(-1);
	const progress = last ? (last.tool_calls_after > 0 ? 0.9 : 0.1) : undefined;
	return {nudge, waiting, progress};
};

createServer((req, res) => {
	let body = '';
	req.on('data', chunk => { body += chunk; });
	req.on('end', () => {
		if (req.method !== 'POST' || req.url !== '/provider/v1/systemone') {
			res.writeHead(404).end('not found'); return;
		}
		const {model, state, questions} = JSON.parse(body);
		const p = judge(state);
		const answer = noul => ({type: 'noul', noul});
		const answers = {
			nudge: answer(p.nudge),
			waiting: answer(p.waiting),
			...(questions.progress ? {progress: answer(p.progress)} : {}),
		};
		appendFileSync('jev-log.jsonl', JSON.stringify({auth: req.headers.authorization, model, state, questions: Object.keys(questions), answers}) + '\n');
		res.writeHead(200, {'content-type': 'application/json'});
		res.end(JSON.stringify({model, answers, usage: {input_tokens: 400, output_tokens: 3}}));
	});
}).listen(4711, '127.0.0.1', () => console.log('fake jev on 4711'));
