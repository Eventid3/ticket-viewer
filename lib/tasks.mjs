// What a new task's file is called and says. Pure: the board writes the file and starts the agent.
import fs from 'node:fs';
import path from 'node:path';

const SLUG_WORDS = 6;
const SLUG_LENGTH = 40;

/** A file name slug: lower-case words joined by `-`, from the title, else the first words of the description. */
export function slugFor(title, description) {
  const words = s => (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const from = words(title).length ? words(title) : words(description).slice(0, SLUG_WORDS);
  return from.join('-').slice(0, SLUG_LENGTH).replace(/-+$/, '') || 'task';
}

/** The number after the highest `NN-` prefix among `files`, as at least two digits. */
export function nextNumber(files) {
  const highest = Math.max(0, ...files.map(f => Number(f.match(/^(\d+)-/)?.[1] ?? 0)));
  return String(highest + 1).padStart(2, '0');
}

/** The file's text: its title, `Status: drafting` and the description. The title is the given one, else the description's first line. */
export function taskMarkdown(number, title, description) {
  const heading = title || description.split('\n')[0].replace(/\s+/g, ' ').trim().replace(/^(.{70}).+$/, '$1…');
  return `# ${number}: ${heading}\n\nStatus: drafting\n\n## Description\n\n${description}\n`;
}

/**
 * Creates the next task file in `dir` and returns its name. `isFree(file)` lets the caller veto a name (its branch
 * or session is taken). The file is created exclusively, so a clash never overwrites anything: the next number is tried.
 */
export function createTaskFile(dir, { title = '', description }, isFree = () => true) {
  fs.mkdirSync(dir, { recursive: true });
  const slug = slugFor(title, description);
  let number = Number(nextNumber(fs.readdirSync(dir)));
  for (;;) {
    const n = String(number++).padStart(2, '0');
    const file = `${n}-${slug}.md`;
    if (!isFree(file)) continue;
    try {
      fs.writeFileSync(path.join(dir, file), taskMarkdown(n, title.trim(), description), { flag: 'wx' });
      return file;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}
