// Tiny test runner for the regression cases: named checks with expected/actual, per-case grouping, JSON + Markdown report, non-zero exit on failure.
const fs = require('fs');
const path = require('path');
class Run {
  constructor(title) { this.title = title; this.results = []; this.current = ''; this.startedAt = Date.now(); this.tables = []; }
  table(title, headers, rows) { this.tables.push({ title, headers, rows }); }
  section(id, name) { this.current = id; console.log(`\n== ${id} ${name}`); this.results.push({ type: 'section', id, name }); }
  check(name, pass, detail = '', expected = '') {
    this.results.push({ type: 'check', case: this.current, name, pass: !!pass, detail: String(detail).slice(0, 400), expected: String(expected).slice(0, 200) });
    console.log(`${pass ? 'PASS' : 'FAIL'}  [${this.current}] ${name}${detail !== '' ? '  [' + String(detail).slice(0, 160) + ']' : ''}`);
    return !!pass;
  }
  blocked(name, reason) { this.results.push({ type: 'check', case: this.current, name, pass: null, detail: reason }); console.log(`BLOCKED  [${this.current}] ${name}  [${reason}]`); }
  // A check for a defect that is already known and written up: passes when fixed, shows as KNOWN (not a failure) while it is still there.
  known(name, pass, detail = '', ref = '') {
    this.results.push({ type: 'check', case: this.current, name, pass: pass ? true : 'known', detail: String(detail).slice(0, 400), ref });
    console.log(`${pass ? 'PASS' : 'KNOWN'}  [${this.current}] ${name}  [${String(detail).slice(0, 160)}]${pass ? '' : ' ' + ref}`);
    return !!pass;
  }
  summary() { const c = this.results.filter((r) => r.type === 'check'); return { total: c.length, passed: c.filter((r) => r.pass === true).length, failed: c.filter((r) => r.pass === false).length, blocked: c.filter((r) => r.pass === null).length, known: c.filter((r) => r.pass === 'known').length, seconds: Math.round((Date.now() - this.startedAt) / 1000) }; }
  save(dir, file) {
    fs.mkdirSync(dir, { recursive: true });
    const s = this.summary();
    fs.writeFileSync(path.join(dir, `${file}.json`), JSON.stringify({ title: this.title, summary: s, results: this.results, tables: this.tables }, null, 2));
    const lines = [`# ${this.title}`, '', `${s.passed}/${s.total} passed, ${s.failed} failed, ${s.blocked} blocked, ${s.known} known issues (${s.seconds} s)`, ''];
    for (const r of this.results) { if (r.type === 'section') lines.push(`\n## ${r.id} ${r.name}\n`); else lines.push(`- ${r.pass === true ? 'PASS' : r.pass === false ? '**FAIL**' : r.pass === 'known' ? 'KNOWN ISSUE' : 'BLOCKED'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`); }
    for (const t of this.tables) lines.push(`
### ${t.title}
`, `| ${t.headers.join(' | ')} |`, `|${t.headers.map(() => '---').join('|')}|`, ...t.rows.map((r) => `| ${r.join(' | ')} |`));
    fs.writeFileSync(path.join(dir, `${file}.md`), lines.join('\n') + '\n');
    return s;
  }
}
module.exports = { Run };
