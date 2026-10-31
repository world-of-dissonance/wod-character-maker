/* Skill Forge logic: the design budgets, and what the page checks a skill against. Also runs under node for tools/forge_core.test.js. */
(function (root) {
  // Unplaytested estimates: every number the Forge judges by lives here, so tuning them later is one edit.
  const BUDGET = {
    rows: {
      A: { level: 0, hp: 18, ep: 10, ap: 11, mod: 2 },
      B: { level: 3, hp: 24, ep: 13, ap: 12, mod: 3 },
      C: { level: 5, hp: 28, ep: 15, ap: 13, mod: 4 },
      D: { level: 9, hp: 32, ep: 17, ap: 14, mod: 5 },
    },
    late: { level: 30, hp: 70, ep: 36, ap: 18, mod: 8 },
    // [slot 1..5]: cast is the default, epShare is of the row's EP, value is the effect's average by column 1/2/3, hpShare is of the row's HP
    slots: [
      { name: 'At-will', job: 'The basic move', cast: 'Instant', epShare: 0, value: [3.5, 4.5, 5.5], plusMod: true },
      { name: 'Tool', job: 'A small buff, debuff or utility', cast: 'Instant', epShare: 0.2, hpShare: 0.25 },
      { name: 'Reaction', job: 'Answers a trigger', cast: 'Reaction', epShare: 0.3, hpShare: 0.25 },
      { name: 'Workhorse', job: "The segment's main effect", cast: '1 Round', epShare: 0.4, value: [7, 10, 12] },
      { name: 'Capstone', job: 'The big play', cast: '1 Round', epShare: 0.78, value: [12, 16, 19], cooldownShare: 0.6 },
    ],
    caps: { ap: [2, 3, 4], rollmod: [2, 3, 4], epdrain: [2, 4, 6], move: [10, 15, 20], control: [1, 2, 3] },
    tempHp: [7, 10, 12], // the Workhorse column
    area: 0.5,
    overTime: 1.5,
    extraCastRound: 0.25,
    instantHpShare: 0.25,
    branchAllowance: 1.25,
  };

  const NUMBERS = ['damage', 'heal', 'temphp'];
  const CAP_LABEL = { ap: 'AP', rollmod: 'Roll modifier', epdrain: 'EP drain', move: 'Movement', control: 'Hard control' };
  const KIND_LABEL = { damage: 'Damage', heal: 'Healing', temphp: 'Temporary HP' };

  const isBranch = track => track !== 'main';

  /** Who a skill in this segment faces: the earliest level that segment can open. */
  function row(track, tier) {
    const key = isBranch(track) ? ['B', 'C', 'D'][tier - 1] : ['A', 'B', 'C'][tier - 1];
    return { ...BUDGET.rows[key] };
  }

  function column(track, tier) {
    return Math.min(3, tier + (isBranch(track) ? 1 : 0));
  }

  function suggest(track, tier, slot) {
    const s = BUDGET.slots[slot - 1];
    const ep = Math.round(row(track, tier).ep * s.epShare);
    return { ep, cast: s.cast, cooldown: ep ? Math.ceil(ep * (s.cooldownShare || 0.5)) : 0 };
  }

  function averageDice(str) {
    if (/^\s*\d+\s*$/.test(str || '')) return Number(str); // a flat amount, like a pool of 20
    const m =/^\s*(\d*)d(\d+)\s*(?:([+-])\s*(\d+))?\s*$/i.exec(str || '');
    if (!m) return null;
    const flat = m[4] ? Number(m[3] + m[4]) : 0;
    return (Number(m[1] || 1) * (Number(m[2]) + 1)) / 2 + flat;
  }

  function effectValue(e, mod) {
    const base = e.dice ? averageDice(e.dice) : e.amount;
    if (base == null) return null;
    return (base + (e.addMod ? mod : 0)) * (e.overTime || 1) * (e.targets || 1);
  }

  function effectLimit(skill, e) {
    const r = row(skill.track, skill.tier), col = column(skill.track, skill.tier) - 1, s = BUDGET.slots[skill.slot - 1];
    let limit = e.kind === 'temphp' ? BUDGET.tempHp[col]
      : s.value ? s.value[col] + (s.plusMod ? r.mod : 0)
      : r.hp * s.hpShare;
    const rounds = Number((/^(\d) Round/.exec(skill.cast || '') || [])[1] || 1);
    limit *= 1 + (rounds - 1) * BUDGET.extraCastRound;
    if (skill.cast === 'Instant' && skill.slot !== 1) limit = Math.min(limit, r.hp * BUDGET.instantHpShare); // an at-will's job is to be quick
    if (e.isArea) limit *= BUDGET.area;
    if (e.overTime > 1) limit *= BUDGET.overTime;
    if (isBranch(skill.track)) limit *= BUDGET.branchAllowance;
    return limit;
  }

  /** Each number in the skill against its limit, for the budget readout. */
  function readout(skill) {
    const mod = row(skill.track, skill.tier).mod;
    return (skill.effects || []).filter(e => NUMBERS.includes(e.kind)).map(e => ({ kind: e.kind, value: effectValue(e, mod), limit: effectLimit(skill, e) }));
  }

  function check(skill) {
    const out = [], col = column(skill.track, skill.tier) - 1, mod = row(skill.track, skill.tier).mod;
    for (const e of skill.effects || []) {
      if (NUMBERS.includes(e.kind)) {
        const value = effectValue(e, mod);
        if (value == null) {
          out.push({ level: 'over', code: 'BAD_DICE', message: `${KIND_LABEL[e.kind]}: "${e.dice || ''}" isn't a dice amount like 2d8+1.` });
          continue;
        }
        const limit = effectLimit(skill, e);
        if (value > limit) out.push({ level: 'over', code: 'OVER_BUDGET', message: `${KIND_LABEL[e.kind]} averages ${round(value)}; this slot allows about ${round(limit)}.` });
        if (!e.addMod) out.push({ level: 'warn', code: 'NO_MOD', message: `${KIND_LABEL[e.kind]} doesn't add a mod, so it fades by level 30.` });
      } else if (BUDGET.caps[e.kind]) {
        const cap = BUDGET.caps[e.kind][col];
        if (Math.abs(e.amount) > cap) out.push({ level: 'over', code: 'OVER_CAP', message: `${CAP_LABEL[e.kind]} ${Math.abs(e.amount)} is over this tier's cap of ${cap}.` });
        if (e.kind === 'control' && skill.roll !== 'save') out.push({ level: 'over', code: 'CONTROL_NO_SAVE', message: 'Hard control always needs a save.' });
      }
    }
    return out;
  }

  /** The skill's numbers at level 30, when its mod has grown. */
  function late(skill) {
    return (skill.effects || []).filter(e => NUMBERS.includes(e.kind) && effectValue(e, 0) != null)
      .map(e => ({ kind: e.kind, value: effectValue(e, BUDGET.late.mod) }));
  }

  const round = n => Math.round(n * 10) / 10;

  // ---------- the words: rules in a fixed order, the doc's row, the lint ----------
  const upper = s => s.charAt(0).toUpperCase() + s.slice(1);
  const rounds = n => `${n} Round${n === 1 ? '' : 's'}`;
  const isSpread = area => /radius|line/i.test(area || '');

  function amountWords(e, skill) {
    const dice = e.dice || String(e.amount ?? '');
    return e.addMod ? `${dice} + ${skill.aspect ? skill.aspect + ' mod' : 'your mod'}` : dice;
  }

  function effectWords(e, skill) {
    const over = e.overTime > 1 ? ` per Round for ${rounds(e.overTime)}` : '';
    const signed = n => (n > 0 ? '+' : '') + n;
    switch (e.kind) {
      case 'damage': return `deal ${amountWords(e, skill)} damage${over}`;
      case 'heal': return `heal ${amountWords(e, skill)} HP${over}`;
      case 'temphp': return `gain ${amountWords(e, skill)} temporary HP, which ends when this skill ends`;
      case 'ap': return `the target gets ${signed(e.amount)} AP`;
      case 'rollmod': return `the target gets ${signed(e.amount)} to its rolls`;
      case 'epdrain': return `the target loses ${Math.abs(e.amount)} EP`;
      case 'move': return `the target gets ${signed(e.amount)} ft of movement`;
      case 'control': return `the target is [${e.condition}] for ${rounds(e.amount)}, and saves again at the end of each of its turns`;
      default: return (e.text || '').trim();
    }
  }

  function targetWords(skill) {
    if (isSpread(skill.area)) return `Affects everything in a ${skill.area}.`;
    const who = skill.area || 'a target';
    if (skill.range === 'Self') return skill.area ? `Affects ${who}.` : '';
    if (skill.range === 'Touch') return `Choose ${who} you can touch.`;
    if (skill.range === 'Weapon') return `Choose ${who} within your weapon's range.`;
    return skill.range ? `Choose ${who} within ${skill.range}.` : '';
  }

  const ROLL_WORDS = {
    attack: a => `Make a ${a} attack against the target's AP.`,
    save: a => `The target makes a ${a} save against your DC (10 + your ${a} mod).`,
    contest: a => `Make a ${a} contest against the target.`,
  };
  const SUCCESS = { attack: 'On a hit, ', save: 'On a failure, ', contest: 'If you win, ', none: '' };
  const CRIT = { attack: 'On a critical hit, ', save: 'On a critical failure, ', contest: 'On a critical win, ' };

  function compose(skill) {
    const roll = skill.roll || 'none', parts = [];
    if (skill.trigger) parts.push(`When ${skill.trigger}, you may use your reaction.`);
    parts.push(targetWords(skill));
    if (ROLL_WORDS[roll]) parts.push(ROLL_WORDS[roll](skill.aspect || 'Essence'));
    const words = (skill.effects || []).map(e => effectWords(e, skill)).filter(Boolean);
    words.forEach((w, i) => {
      const lead = i === 0 ? SUCCESS[roll] : 'Also ';
      const line = lead ? lead + w : upper(w);
      parts.push(/[.!?]$/.test(line) ? line : line + '.');
    });
    if (roll === 'save' && (skill.effects || []).some(e => e.kind === 'damage')) parts.push('On a success, half; on a critical success, none.');
    if (skill.crit && CRIT[roll]) parts.push(`${CRIT[roll]}${skill.crit}.`);
    if (skill.lasts && skill.lasts !== 'Instant') parts.push(`Lasts ${skill.lasts}.`);
    return parts.filter(Boolean).join(' ');
  }

  function docCells(skill) {
    const flavour = (skill.flavour || '').trim(), range = isSpread(skill.area) ? `${skill.range}, ${skill.area}` : skill.range;
    return [`#${skill.slot} ${(skill.name || '').trim()}`, `EP\n${skill.ep}`, (flavour ? flavour + '\n' : '') + compose(skill),
      `Cast Time: ${skill.cast}`, `Lasts For: ${skill.lasts || 'Instant'}`, `Range: ${range}`, `Cooldown: ${skill.cooldown ? rounds(skill.cooldown) : 'N/A'}`];
  }

  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /** One table row of seven cells, what a Google Doc takes on paste. */
  function docHtml(skill) {
    const cells = docCells(skill).map((c, i) => {
      if (i === 2 && (skill.flavour || '').trim()) {
        const [first, ...rest] = c.split('\n');
        return `<i>${esc(first)}</i><br>${esc(rest.join(' '))}`;
      }
      return esc(c).replace(/\n/g, '<br>');
    });
    return `<table><tbody><tr>${cells.map(c => `<td>${c}</td>`).join('')}</tr></tbody></table>`;
  }

  const docText = skill => docCells(skill).map(c => c.replace(/\s*\n\s*/g, ' ')).join('\t');

  function lint(skill, known) {
    const out = check(skill), names = (known.skillNames || []).map(n => n.toLowerCase()), tags = (known.tags || []).map(t => t.toLowerCase());
    const name = (skill.name || '').trim(), text = (skill.effects || []).filter(e => e.kind === 'custom').map(e => e.text || '').join(' ');
    if (!name) out.push({ level: 'warn', code: 'NO_NAME', message: 'The skill needs a name.' });
    if (name && names.includes(name.toLowerCase())) out.push({ level: 'over', code: 'DUPLICATE_NAME', message: `"${name}" already exists. The wiki keeps only the first copy, so this one would vanish.` });
    if ((skill.flavour || '').trim().split(/\s+/).length > 20) out.push({ level: 'warn', code: 'FLAVOUR_LONG', message: 'Keep the flavour line to 20 words.' });
    if ((skill.effects || []).length > 2) out.push({ level: 'warn', code: 'TOO_MANY_EFFECTS', message: 'One verb and one twist: at most two effects.' });
    for (const [, raw] of text.matchAll(/\[([^\]]+)\]/g)) {
      const tag = raw.trim().toLowerCase();
      if (/^\d/.test(tag)) continue; // a dice table's row, like [1-2 x]
      if (tag === name.toLowerCase()) continue;
      if (names.includes(tag)) out.push({ level: 'warn', code: 'PREREQUISITE', message: `Needing [${raw}] costs two of a character's 15 slots.` });
      else if (!tags.includes(tag)) out.push({ level: 'warn', code: 'UNKNOWN_TAG', message: `[${raw}] isn't in the glossary yet.` });
    }
    const die = /\b\d*d(\d+)\b/i.exec(text);
    if (die) {
      const top = Math.max(0, ...[...text.matchAll(/\[(\d+)(?:\s*-\s*(\d+))?/g)].map(m => Number(m[2] || m[1])));
      if (top > Number(die[1])) out.push({ level: 'over', code: 'DICE_TABLE', message: `The table goes up to ${top}, but the die is a d${die[1]}.` });
    }
    return out;
  }

  const EFFECT_KINDS = [...NUMBERS, 'ap', 'rollmod', 'epdrain', 'move', 'control', 'custom'];
  const allOf = (o, keys, type) => keys.every(k => o[k] === undefined || typeof o[k] === type);

  /** Drafts come back from browser storage and from files people import, so the page checks their shape before trusting them. */
  function validDraft(d) {
    return !!d && typeof d === 'object' && typeof d.track === 'string' && [1, 2, 3].includes(d.tier) && [1, 2, 3, 4, 5].includes(d.slot) && Array.isArray(d.effects)
      && allOf(d, ['tree', 'name', 'flavour', 'cast', 'lasts', 'range', 'area', 'roll', 'aspect', 'trigger', 'crit'], 'string') && allOf(d, ['ep', 'cooldown'], 'number')
      && d.effects.every(e => !!e && EFFECT_KINDS.includes(e.kind) && allOf(e, ['dice', 'text', 'condition'], 'string') && allOf(e, ['amount', 'overTime', 'targets'], 'number'));
  }

  const Forge = { BUDGET, row, column, suggest, averageDice, check, late, readout, compose, lint, docCells, docHtml, docText, validDraft };
  if (typeof module !== 'undefined' && module.exports) module.exports = Forge;
  else root.Forge = Forge;
})(typeof globalThis !== 'undefined' ? globalThis : this);
