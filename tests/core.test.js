'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseSrt, serializeSrt, buildPlan, applyDecisions } = require('../src/core.js');

function timestamp(ms) {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor(ms / 60000) % 60;
  const seconds = Math.floor(ms / 1000) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

function cues(texts, { offset = 0, firstId = 1 } = {}) {
  return parseSrt(texts.map((text, i) => `${firstId + i}\n${timestamp(offset + i * 2000)} --> ${timestamp(offset + i * 2000 + 1500)}\n${text}`).join('\n\n'));
}

function plan(before, after, current) {
  return buildPlan(cues(before), cues(after), cues(current, { offset: 30000, firstId: 101 }));
}

function timeline(items) {
  return items.map(({ id, startMs, endMs, timingLine }) => ({ id, startMs, endMs, timingLine }));
}

function keepUnresolved(result) {
  return Object.fromEntries(result.changes.filter(change => ['conflict', 'not-found'].includes(change.status)).map(change => [change.id, { action: 'keep' }]));
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) if (child && typeof child === 'object' && !Object.isFrozen(child)) deepFreeze(child);
  return value;
}

test('parseSrt normalizes BOM and CRLF while retaining multiline Unicode text and IDs', () => {
  const parsed = parseSrt('\uFEFF007\r\n00:00:01,020 --> 00:00:03,040\r\n第一行\r\nSecond line 🎬\r\n\r\n42\r\n00:00:05,000 --> 00:00:06,000\r\n尾声\r\n');
  assert.deepEqual(parsed, [
    { id: '007', startMs: 1020, endMs: 3040, timingLine: '00:00:01,020 --> 00:00:03,040', text: '第一行\nSecond line 🎬' },
    { id: '42', startMs: 5000, endMs: 6000, timingLine: '00:00:05,000 --> 00:00:06,000', text: '尾声' }
  ]);
});

test('parse and serialization support a duration beyond 99 hours', () => {
  const parsed = parseSrt('91\n123:45:56,789 --> 124:00:00,001\nLong recording');
  assert.equal(parsed[0].startMs, 445556789);
  assert.equal(parsed[0].endMs, 446400001);
  assert.deepEqual(parseSrt(serializeSrt(parsed)), parsed);
});

test('serialization retains cue order, nonsequential IDs, timing lines and literal text', () => {
  const original = parseSrt('8\n00:00:04,000 --> 00:00:05,000\nA\nline\n\n3\n00:00:01,000 --> 00:00:02,000\n  padded text  ');
  const serialized = serializeSrt(original);
  assert.deepEqual(parseSrt(serialized), original);
  assert.match(serialized, /A\nline\n\n3\n/);
  assert.equal(original[1].text, '  padded text  ');
});

const invalidSrt = [
  ['empty input', ''],
  ['whitespace-only input', ' \n\t'],
  ['missing cue ID', '00:00:01,000 --> 00:00:02,000\ntext'],
  ['nonnumeric cue ID', 'one\n00:00:01,000 --> 00:00:02,000\ntext'],
  ['missing timestamp', '1\ntext'],
  ['invalid timestamp separator', '1\n00:00:01.000 --> 00:00:02.000\ntext'],
  ['invalid arrow', '1\n00:00:01,000 -> 00:00:02,000\ntext'],
  ['out-of-range minutes', '1\n00:60:00,000 --> 01:01:00,000\ntext'],
  ['out-of-range seconds', '1\n00:00:60,000 --> 00:01:01,000\ntext'],
  ['invalid milliseconds', '1\n00:00:00,0000 --> 00:00:01,000\ntext'],
  ['negative start', '1\n-00:00:01,000 --> 00:00:02,000\ntext'],
  ['end before start', '1\n00:00:02,000 --> 00:00:01,000\ntext'],
  ['zero duration', '1\n00:00:01,000 --> 00:00:01,000\ntext'],
  ['empty cue text', '1\n00:00:01,000 --> 00:00:02,000\n'],
  ['whitespace-only cue text', '1\n00:00:01,000 --> 00:00:02,000\n   '],
  ['duplicate ID', '1\n00:00:01,000 --> 00:00:02,000\nfirst\n\n1\n00:00:03,000 --> 00:00:04,000\nsecond'],
  ['unrecognized trailing timing content', '1\n00:00:01,000 --> 00:00:02,000 nonsense\ntext']
];

for (const [name, input] of invalidSrt) {
  test(`parseSrt rejects ${name} with an informative error`, () => {
    assert.throws(() => parseSrt(input), error => error instanceof Error && error.message.trim().length > 0);
  });
}

test('only actual A-to-B text edits produce plan entries', () => {
  const result = plan(['stay', 'typo'], ['stay', 'fixed'], ['intro', 'typo', 'stay']);
  assert.equal(result.changes.length, 1);
  assert.deepEqual(result.changes.map(({ before, after, oldIndex, status, targetIndex }) => ({ before, after, oldIndex, status, targetIndex })), [
    { before: 'typo', after: 'fixed', oldIndex: 1, status: 'ready', targetIndex: 1 }
  ]);
  assert.equal(result.stats.ready, 1);
  assert.equal(new Set(result.changes.map(change => change.id)).size, result.changes.length);
});

test('a unique exact match carries the whole correction across a shifted, reordered C timeline', () => {
  const result = plan(['old first', 'unchanged', 'old last'], ['new first', 'unchanged', 'new last'], ['inserted intro', 'old last', 'unchanged', 'old first']);
  const output = applyDecisions(result);
  assert.deepEqual(output.cues.map(cue => cue.text), ['inserted intro', 'new last', 'unchanged', 'new first']);
  assert.deepEqual(timeline(output.cues), timeline(result.current));
  assert.deepEqual(parseSrt(serializeSrt(output.cues)), output.cues);
});

test('normalized whitespace is an exact anchor, preserving the corrected multiline text', () => {
  const result = plan(['hello world'], ['Hello,\nworld!'], ['hello   world']);
  assert.equal(result.changes[0].status, 'ready');
  assert.equal(applyDecisions(result).cues[0].text, 'Hello,\nworld!');
});

test('unchanged content in C stays byte-for-byte at text level', () => {
  const result = plan(['wrong', 'steady'], ['right', 'steady'], ['  keep my spaces  ', 'wrong', '<i>steady</i>\n第二行']);
  const output = applyDecisions(result);
  assert.equal(output.cues[0].text, '  keep my spaces  ');
  assert.equal(output.cues[2].text, '<i>steady</i>\n第二行');
});

test('buildPlan rejects A/B cue insertion or removal', () => {
  assert.throws(() => buildPlan(cues(['a']), cues(['b', 'added']), cues(['a'])));
  assert.throws(() => buildPlan(cues(['a', 'removed']), cues(['b']), cues(['a'])));
});

test('buildPlan rejects A/B ID changes and timing changes', () => {
  assert.throws(() => buildPlan(cues(['a']), cues(['b'], { firstId: 2 }), cues(['a'])));
  assert.throws(() => buildPlan(cues(['a']), cues(['b'], { offset: 1 }), cues(['a'])));
  const base = cues(['a']);
  const changed = cues(['b']);
  changed[0].endMs += 1;
  changed[0].timingLine = '00:00:00,000 --> 00:00:01,501';
  assert.throws(() => buildPlan(base, changed, cues(['a'])));
});

test('repeated original text remains ambiguous when only one occurrence survives in C', () => {
  const result = plan(['好的。', '好的。'], ['好的，开始吧。', '好的。'], ['好的。']);
  assert.equal(result.changes[0].status, 'conflict');
  assert.equal(result.changes[0].targetIndex, null);
  assert.throws(() => applyDecisions(result));
});

test('repeated C matches and whitespace-equivalent duplicates require review', () => {
  for (const current of [['old phrase', 'old phrase'], ['old phrase', 'old   phrase']]) {
    const result = plan(['old phrase'], ['correct phrase'], current);
    assert.equal(result.changes[0].status, 'conflict');
    assert.throws(() => applyDecisions(result));
  }
});

test('presence of both original and corrected text in C is ambiguous', () => {
  const result = plan(['old'], ['corrected'], ['old', 'corrected']);
  assert.equal(result.changes[0].status, 'conflict');
  assert.equal(result.changes[0].targetIndex, null);
  assert.throws(() => applyDecisions(result));
});

test('a unique already-corrected cue is preserved without a second application', () => {
  const result = plan(['old spelling'], ['correct spelling'], ['opening', 'correct spelling']);
  assert.equal(result.changes[0].status, 'already-applied');
  assert.deepEqual(applyDecisions(result).cues, result.current);
});

test('a corrected text that also belonged to another source cue cannot prove already-applied', () => {
  const result = plan(['bad', 'good'], ['good', 'good'], ['good']);
  assert.equal(result.changes[0].status, 'conflict');
  assert.throws(() => applyDecisions(result));
});

test('repeated corrected text in C cannot prove already-applied', () => {
  const result = plan(['bad'], ['good'], ['good', 'good']);
  assert.equal(result.changes[0].status, 'conflict');
  assert.throws(() => applyDecisions(result));
});

test('similar text is only a suggestion and never auto-applies', () => {
  const result = plan(['The small green train leaves today.'], ['The small green tram leaves today.'], ['The small green train leaves tomorrow.']);
  const change = result.changes[0];
  assert.equal(change.status, 'not-found');
  assert.equal(change.targetIndex, null);
  assert.ok(change.candidates.some(candidate => candidate.index === 0));
  for (const candidate of change.candidates) assert.ok(Number.isFinite(candidate.score));
  assert.throws(() => applyDecisions(result));
  assert.deepEqual(applyDecisions(result, keepUnresolved(result)).cues, result.current);
});

test('missing, split, or merged phrases cannot be resurrected automatically', () => {
  for (const current of [['unrelated new scene'], ['alpha beta', 'gamma delta'], ['intro alpha beta gamma delta outro']]) {
    const result = plan(['alpha beta gamma delta'], ['alpha beta corrected delta'], current);
    assert.equal(result.changes[0].status, 'not-found');
    assert.throws(() => applyDecisions(result));
    const output = applyDecisions(result, keepUnresolved(result));
    assert.deepEqual(output.cues, result.current);
  }
});

test('explicit keep can decline a ready correction', () => {
  const result = plan(['wrong'], ['right'], ['wrong']);
  assert.deepEqual(applyDecisions(result, { [result.changes[0].id]: { action: 'keep' } }).cues, result.current);
});

test('explicit application chooses one conflicting destination and preserves all others', () => {
  const result = plan(['wrong'], ['right'], ['wrong', 'wrong']);
  const output = applyDecisions(result, { [result.changes[0].id]: { action: 'apply', targetIndex: 1 } });
  assert.deepEqual(output.cues.map(cue => cue.text), ['wrong', 'right']);
  assert.deepEqual(timeline(output.cues), timeline(result.current));
});

test('an explicit destination can carry a missing correction after human review', () => {
  const result = plan(['old phrase'], ['human corrected phrase'], ['rewritten phrase', 'keep']);
  const output = applyDecisions(result, { [result.changes[0].id]: { action: 'apply', targetIndex: 0 } });
  assert.deepEqual(output.cues.map(cue => cue.text), ['human corrected phrase', 'keep']);
  assert.deepEqual(timeline(output.cues), timeline(result.current));
});

test('unresolved corrections block output even when another correction is ready', () => {
  const result = plan(['old one', 'deleted two'], ['new one', 'fixed two'], ['old one']);
  assert.equal(result.changes[0].status, 'ready');
  assert.equal(result.changes[1].status, 'not-found');
  assert.throws(() => applyDecisions(result));
  assert.equal(result.current[0].text, 'old one');
});

test('apply without a destination fails for unresolved changes', () => {
  const result = plan(['old'], ['new'], ['unrelated']);
  assert.throws(() => applyDecisions(result, { [result.changes[0].id]: { action: 'apply' } }));
});

test('invalid destinations and unknown actions are rejected', () => {
  const result = plan(['old'], ['new'], ['unrelated']);
  for (const targetIndex of [-1, 1, 0.5, '0', NaN, Infinity, null]) {
    assert.throws(() => applyDecisions(result, { [result.changes[0].id]: { action: 'apply', targetIndex } }));
  }
  assert.throws(() => applyDecisions(result, { [result.changes[0].id]: { action: 'guess' } }));
});

test('two corrections cannot overwrite one destination', () => {
  const result = plan(['old one', 'old two'], ['new one', 'new two'], ['a new cue']);
  const decisions = Object.fromEntries(result.changes.map(change => [change.id, { action: 'apply', targetIndex: 0 }]));
  assert.throws(() => applyDecisions(result, decisions));
  assert.equal(result.current[0].text, 'a new cue');
});

test('an explicit destination cannot collide with an automatically ready correction', () => {
  const result = plan(['old one', 'old two'], ['new one', 'new two'], ['old one']);
  assert.throws(() => applyDecisions(result, { [result.changes[1].id]: { action: 'apply', targetIndex: 0 } }));
});

test('planning and applying never mutate caller arrays, cues, plan, or decisions', () => {
  const base = deepFreeze(cues(['wrong', 'missing']));
  const corrected = deepFreeze(cues(['right', 'fixed']));
  const current = deepFreeze(cues(['intro', 'wrong'], { offset: 15000, firstId: 71 }));
  const result = buildPlan(base, corrected, current);
  assert.notStrictEqual(result.current, current);
  assert.notStrictEqual(result.current[0], current[0]);
  const snapshot = JSON.stringify(result);
  const decisions = deepFreeze(keepUnresolved(result));
  deepFreeze(result);
  const output = applyDecisions(result, decisions);
  assert.equal(JSON.stringify(result), snapshot);
  assert.equal(current[1].text, 'wrong');
  assert.equal(output.cues[1].text, 'right');
  assert.notStrictEqual(output.cues, result.current);
  assert.notStrictEqual(output.cues[0], result.current[0]);
});

test('audit records each change and is JSON serializable', () => {
  const result = plan(['wrong', 'missing', 'old'], ['right', 'fixed', 'already'], ['wrong', 'already']);
  const output = applyDecisions(result, keepUnresolved(result));
  assert.ok(Array.isArray(output.audit));
  assert.equal(output.audit.length, result.changes.length);
  assert.deepEqual(JSON.parse(JSON.stringify(output.audit)), output.audit);
  const json = JSON.stringify(output.audit);
  assert.match(json, /wrong/);
  assert.match(json, /right/);
  assert.doesNotMatch(json, /C:\\\\|\/Users\/|\/home\/|file:\/\//);
});

test('skipped unmatched corrections retain source identity in audit', () => {
  const result = plan(['wrong source phrase'], ['human corrected phrase'], ['unrelated new phrase']);
  const output = applyDecisions(result, keepUnresolved(result));
  const audit = JSON.parse(JSON.stringify(output.audit))[0];
  assert.equal(audit.oldIndex, 0);
  assert.equal(audit.sourceBefore, 'wrong source phrase');
  assert.equal(audit.sourceAfter, 'human corrected phrase');
  assert.equal(audit.action, 'keep');
  assert.equal(audit.targetIndex, null);
  assert.equal(audit.before, null);
  assert.equal(audit.after, null);
});

test('HTML-looking and script-looking subtitle content stays literal through the core', () => {
  const dangerous = '<img src=x onerror="globalThis.cueCarryExecuted=true">\n<script>globalThis.cueCarryExecuted=true</script> & text';
  delete globalThis.cueCarryExecuted;
  const result = plan(['plain'], [dangerous], ['plain']);
  const output = applyDecisions(result);
  assert.equal(output.cues[0].text, dangerous);
  assert.equal(parseSrt(serializeSrt(output.cues))[0].text, dangerous);
  assert.equal(globalThis.cueCarryExecuted, undefined);
});

test('no changes produces a clean pass-through copy', () => {
  const result = plan(['same'], ['same'], ['intro', 'same']);
  assert.deepEqual(result.changes, []);
  const output = applyDecisions(result);
  assert.deepEqual(output.cues, result.current);
  assert.deepEqual(output.audit, []);
});

test('synthetic example files cover ready, conflict, missing, suggestion and already-applied', () => {
  const read = name => parseSrt(fs.readFileSync(path.join(__dirname, '..', 'examples', name), 'utf8'));
  const current = read('C-new-timeline.srt');
  const result = buildPlan(read('A-original.srt'), read('B-corrected.srt'), current);
  assert.equal(result.changes.length, 5);
  assert.deepEqual(result.changes.map(change => change.status), ['ready', 'conflict', 'not-found', 'not-found', 'already-applied']);
  assert.ok(result.changes[2].candidates.length > 0);
  const output = applyDecisions(result, keepUnresolved(result));
  assert.deepEqual(timeline(output.cues), timeline(current));
  assert.equal(output.cues.length, current.length);
  assert.equal(output.cues[1].text, '它是一个语音识别示例。');
  assert.equal(output.cues[2].text, '好的。');
  assert.equal(output.cues[3].text, '今天我们详细介绍自动字幕。');
});
