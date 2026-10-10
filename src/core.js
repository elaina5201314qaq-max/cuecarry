(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CueCarry = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STATUSES = ['ready', 'already-applied', 'conflict', 'not-found'];
  var MAX_CANDIDATES = 6;
  var MAX_GRAMS = 256;
  var MAX_POSTINGS = 128;

  function normalized(text) {
    return text.replace(/\s+/gu, ' ').trim();
  }

  function canonicalId(id) {
    return id.replace(/^0+(?=\d)/, '');
  }

  function readTiming(line, label) {
    if (typeof line !== 'string') throw new Error(label + '：缺少时间行。');
    if (/[\r\n]/.test(line)) throw new Error(label + '：时间行不能包含换行。');
    var match = /^[ \t]*(\d{2,}):(\d{2}):(\d{2}),(\d{3})[ \t]*-->[ \t]*(\d{2,}):(\d{2}):(\d{2}),(\d{3})(.*)$/.exec(line);
    if (!match) throw new Error(label + '：时间格式应为 HH:MM:SS,mmm --> HH:MM:SS,mmm。');
    if (!/^(?:[ \t]+(?:X1|X2|Y1|Y2):[ \t]*\d+)*[ \t]*$/.test(match[9])) {
      throw new Error(label + '：时间行包含不支持的附加内容。');
    }
    function milliseconds(offset) {
      var minutes = Number(match[offset + 1]);
      var seconds = Number(match[offset + 2]);
      if (minutes > 59 || seconds > 59) throw new Error(label + '：分钟和秒必须在 00–59 之间。');
      var value = Number(match[offset]) * 3600000 + minutes * 60000 + seconds * 1000 + Number(match[offset + 3]);
      if (!Number.isSafeInteger(value)) throw new Error(label + '：时间值过大。');
      return value;
    }
    var startMs = milliseconds(1);
    var endMs = milliseconds(5);
    if (endMs <= startMs) throw new Error(label + '：结束时间必须晚于开始时间。');
    return { startMs: startMs, endMs: endMs };
  }

  function validateCues(cues, name) {
    if (!Array.isArray(cues)) throw new TypeError(name + '必须是字幕数组。');
    var seen = new Set();
    cues.forEach(function (cue, index) {
      var label = name + '第 ' + (index + 1) + ' 条';
      if (!cue || typeof cue.id !== 'string' || !/^\d+$/.test(cue.id) || cue.id.trim() !== cue.id) {
        throw new Error(label + '：编号必须是非负整数。');
      }
      var key = canonicalId(cue.id);
      if (seen.has(key)) throw new Error(label + '：字幕编号重复（' + cue.id + '）。');
      seen.add(key);
      var time = readTiming(cue.timingLine, label);
      if (cue.startMs !== time.startMs || cue.endMs !== time.endMs) {
        throw new Error(label + '：时间字段与原始时间行不一致。');
      }
      if (typeof cue.text !== 'string' || !cue.text.trim()) throw new Error(label + '：字幕正文不能为空。');
      if (/\r|\n[ \t]*\n/.test(cue.text)) throw new Error(label + '：正文含有无效换行或空白分隔行。');
    });
  }

  function cloneCue(cue) {
    return { id: cue.id, startMs: cue.startMs, endMs: cue.endMs, timingLine: cue.timingLine, text: cue.text };
  }

  function parseSrt(text) {
    if (typeof text !== 'string') throw new TypeError('SRT 内容必须是文本。');
    var input = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    if (!input.trim()) throw new Error('SRT 为空，请提供至少一条字幕。');
    input = input.replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '');
    var blocks = input.split(/\n(?:[ \t]*\n)+/);
    var cues = blocks.map(function (block, index) {
      var label = '第 ' + (index + 1) + ' 条字幕';
      var lines = block.split('\n');
      var id = lines[0].trim();
      if (!/^\d+$/.test(id)) throw new Error(label + '：缺少有效的数字编号。');
      if (lines.length < 3) throw new Error(label + '：需要编号、时间行和非空正文。');
      var time = readTiming(lines[1], label);
      for (var i = 2; i + 1 < lines.length; i += 1) {
        if (/^\d+$/.test(lines[i].trim()) && /^\s*\d{2,}:\d{2}:\d{2},\d{3}\s*-->/.test(lines[i + 1])) {
          throw new Error(label + '：字幕之间缺少空白分隔行。');
        }
      }
      return { id: id, startMs: time.startMs, endMs: time.endMs, timingLine: lines[1], text: lines.slice(2).join('\n') };
    });
    validateCues(cues, 'SRT ');
    return cues;
  }

  function serializeSrt(cues) {
    validateCues(cues, '输出 ');
    if (!cues.length) return '';
    return cues.map(function (cue) { return cue.id + '\n' + cue.timingLine + '\n' + cue.text; }).join('\n\n') + '\n';
  }

  function indexText(cues) {
    var result = new Map();
    cues.forEach(function (cue, index) {
      var key = normalized(cue.text);
      if (!result.has(key)) result.set(key, []);
      result.get(key).push(index);
    });
    return result;
  }

  // Sample a bounded number of character pairs, including both ends of long cues.
  // This index proposes candidates only; its score never authorizes a replacement.
  function grams(text) {
    var chars = Array.from(normalized(text).toLowerCase());
    var result = new Set();
    if (chars.length < 2) return result;
    var pairs = chars.length - 1;
    var count = Math.min(pairs, MAX_GRAMS);
    for (var i = 0; i < count; i += 1) {
      var offset = count === 1 ? 0 : Math.floor(i * (pairs - 1) / (count - 1));
      result.add(chars[offset] + chars[offset + 1]);
    }
    return result;
  }

  function makeSuggestions(current) {
    var sets = current.map(function (cue) { return grams(cue.text); });
    var postings = new Map();
    sets.forEach(function (set, index) {
      set.forEach(function (gram) {
        if (!postings.has(gram)) postings.set(gram, []);
        var list = postings.get(gram);
        if (list === null) return;
        if (list.length >= MAX_POSTINGS) postings.set(gram, null);
        else list.push(index);
      });
    });
    return function (text) {
      if (Array.from(normalized(text)).length < 4) return [];
      var source = grams(text);
      var hits = new Map();
      var useful = Array.from(source).filter(function (gram) { return postings.get(gram); });
      useful.sort(function (a, b) { return postings.get(a).length - postings.get(b).length; });
      useful.slice(0, 64).forEach(function (gram) {
        postings.get(gram).forEach(function (index) { hits.set(index, (hits.get(index) || 0) + 1); });
      });
      var pool = Array.from(hits.keys()).sort(function (a, b) { return hits.get(b) - hits.get(a) || a - b; }).slice(0, 48);
      return pool.map(function (index) {
        var shared = 0;
        source.forEach(function (gram) { if (sets[index].has(gram)) shared += 1; });
        var score = 2 * shared / (source.size + sets[index].size);
        return { index: index, score: Math.round(score * 1000) / 1000 };
      }).filter(function (candidate) { return candidate.score >= 0.3; })
        .sort(function (a, b) { return b.score - a.score || a.index - b.index; }).slice(0, MAX_CANDIDATES);
    };
  }

  function buildPlan(baseCues, correctedCues, currentCues) {
    validateCues(baseCues, 'A ');
    validateCues(correctedCues, 'B ');
    validateCues(currentCues, 'C ');
    if (baseCues.length !== correctedCues.length) {
      throw new Error('A/B 字幕条数不同：当前版本只支持改正文，不支持增删、拆分或合并 A/B 字幕。');
    }
    baseCues.forEach(function (cue, index) {
      var fixed = correctedCues[index];
      if (cue.id !== fixed.id || cue.startMs !== fixed.startMs || cue.endMs !== fixed.endMs) {
        throw new Error('A/B 第 ' + (index + 1) + ' 条的编号或时间不同：请保持 A/B 的结构，仅修改正文。');
      }
    });

    var baseIndex = indexText(baseCues);
    var correctedIndex = indexText(correctedCues);
    var currentIndex = indexText(currentCues);
    var suggest = null;
    var claims = new Map();
    var changes = [];
    baseCues.forEach(function (cue, oldIndex) {
      var after = correctedCues[oldIndex].text;
      if (cue.text === after) return;
      var beforeKey = normalized(cue.text);
      var afterKey = normalized(after);
      var beforeMatches = currentIndex.get(beforeKey) || [];
      var afterMatches = currentIndex.get(afterKey) || [];
      var sameKey = beforeKey === afterKey;
      var keys = sameKey ? [beforeKey] : [beforeKey, afterKey];
      keys.forEach(function (key) { claims.set(key, (claims.get(key) || 0) + 1); });
      var exactCount = beforeMatches.length + (sameKey ? 0 : afterMatches.length);
      var exact = beforeMatches.slice(0, MAX_CANDIDATES).concat(sameKey ? [] : afterMatches.slice(0, MAX_CANDIDATES));
      var change = {
        id: 'change-' + (changes.length + 1), oldIndex: oldIndex,
        before: cue.text, after: after, status: 'not-found', targetIndex: null,
        reason: '', candidates: exact.slice(0, MAX_CANDIDATES).map(function (index) { return { index: index, score: 1 }; })
      };

      if (!exactCount) {
        if (!suggest) suggest = makeSuggestions(currentCues);
        change.candidates = suggest(cue.text);
        change.reason = change.candidates.length
          ? 'C 中没有原文或修订文的完整匹配；相似候选仅供人工判断，可能已改写、拆分或合并。'
          : 'C 中未找到匹配；这不代表字幕已删除。请选择保留 C，或手动指定迁移位置。';
      } else if (baseIndex.get(beforeKey).length > 1) {
        change.status = 'conflict';
        change.reason = '原文在 A 中重复出现；即使 C 只剩一个匹配，也无法确定它对应哪一条。';
      } else if (exactCount > 1) {
        change.status = 'conflict';
        change.reason = beforeMatches.length && afterMatches.length && !sameKey
          ? 'C 同时包含原文和修订文，无法确定应迁移到哪一条。'
          : 'C 中存在多个相同或仅空白不同的匹配，需要人工指定位置。';
      } else if (beforeMatches.length === 1) {
        change.targetIndex = beforeMatches[0];
        if (currentCues[change.targetIndex].text === after) {
          change.status = 'already-applied';
          change.reason = '唯一匹配的正文已与修订文相同，无需再次修改。';
        } else {
          change.status = 'ready';
          change.reason = currentCues[change.targetIndex].text === cue.text
            ? 'A 与 C 的原文均唯一且完整匹配，可以迁移正文修订。'
            : 'A 与 C 的原文均唯一，规范化空白后完整匹配，可以迁移正文修订。';
        }
      } else {
        var otherOriginals = baseIndex.get(afterKey) || [];
        if (otherOriginals.length || correctedIndex.get(afterKey).length > 1) {
          change.status = 'conflict';
          change.reason = '虽然 C 包含修订文，但该文字也属于 A/B 中的其他字幕，无法确认修订已经迁入。';
        } else {
          change.status = 'already-applied';
          change.targetIndex = afterMatches[0];
          change.reason = 'C 中唯一匹配修订文，且 A/B 中没有其他同文字幕；视为已迁入，保留 C 正文。';
        }
      }
      changes.push(change);
    });

    changes.forEach(function (change) {
      if (change.targetIndex !== null && claims.get(normalized(currentCues[change.targetIndex].text)) > 1) {
        change.status = 'conflict';
        change.targetIndex = null;
        change.reason = '这条 C 字幕同时匹配多项修订的原文或修订文，需要人工分配，避免互相覆盖。';
      }
    });
    var stats = { ready: 0, 'already-applied': 0, conflict: 0, 'not-found': 0 };
    changes.forEach(function (change) { stats[change.status] += 1; });
    return { changes: changes, current: currentCues.map(cloneCue), stats: stats };
  }

  function applyDecisions(plan, decisions) {
    if (!plan || !Array.isArray(plan.changes)) throw new TypeError('迁移方案无效。');
    validateCues(plan.current, '方案 C ');
    if (decisions === undefined) decisions = {};
    if (!decisions || typeof decisions !== 'object' || Array.isArray(decisions)) throw new TypeError('决策必须是按修订编号索引的对象。');
    var ids = new Set();
    plan.changes.forEach(function (change) {
      if (!change || typeof change.id !== 'string' || ids.has(change.id) || STATUSES.indexOf(change.status) === -1 ||
          typeof change.before !== 'string' || typeof change.after !== 'string' || !change.after.trim() || /\r|\n[ \t]*\n/.test(change.after)) {
        throw new Error('方案中的修订记录无效或编号重复。');
      }
      ids.add(change.id);
    });
    Object.keys(decisions).forEach(function (id) {
      if (!ids.has(id)) throw new Error('决策引用了不存在的修订：' + id + '。');
    });

    var destinations = new Set();
    var audit = plan.changes.map(function (change) {
      var explicit = Object.prototype.hasOwnProperty.call(decisions, change.id);
      var decision = explicit ? decisions[change.id] : null;
      if (explicit && (!decision || typeof decision !== 'object' || ['keep', 'apply'].indexOf(decision.action) === -1)) {
        throw new Error(change.id + '：决策必须为 keep 或 apply。');
      }
      if (!explicit && (change.status === 'conflict' || change.status === 'not-found')) {
        throw new Error(change.id + ' 尚未处理：冲突或未找到的修订需要明确选择。');
      }
      var action = explicit ? decision.action : (change.status === 'ready' ? 'apply' : 'keep');
      var target = explicit && action === 'apply' && Object.prototype.hasOwnProperty.call(decision, 'targetIndex')
        ? decision.targetIndex : change.targetIndex;
      var validTarget = Number.isInteger(target) && target >= 0 && target < plan.current.length;
      if (action === 'apply') {
        if (!validTarget) throw new Error(change.id + '：请指定有效的 C 字幕位置。');
        if (destinations.has(target)) throw new Error('多项修订不能覆盖同一条 C 字幕（第 ' + (target + 1) + ' 条）。');
        destinations.add(target);
      }
      var before = validTarget ? plan.current[target].text : null;
      return {
        changeId: change.id, status: change.status, action: action, explicit: explicit,
        oldIndex: change.oldIndex, sourceBefore: change.before, sourceAfter: change.after,
        targetIndex: validTarget ? target : null, before: before, after: action === 'apply' ? change.after : before
      };
    });
    var cues = plan.current.map(cloneCue);
    audit.forEach(function (entry) { if (entry.action === 'apply') cues[entry.targetIndex].text = entry.after; });
    return { cues: cues, audit: audit };
  }

  return { parseSrt: parseSrt, serializeSrt: serializeSrt, buildPlan: buildPlan, applyDecisions: applyDecisions };
});
