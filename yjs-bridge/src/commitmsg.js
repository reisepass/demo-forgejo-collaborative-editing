// Commit messages derived from line counts only. Document text is never quoted: commit messages
// are visible to everyone with repository access and survive in every mirror.
import { diffLines, splitLines } from './shared/merge.js';

export function lineCounts(before, after) {
  let added = 0;
  let removed = 0;
  for (const h of diffLines(splitLines(before), splitLines(after))) { added += h.lines.length; removed += h.e - h.s; }
  return { added, removed };
}

const trailers = (coAuthors) => (coAuthors.length ? '\n\n' + coAuthors.map((p) => `Co-authored-by: ${p.name} <${p.email}>`).join('\n') : '');

export function liveEditMessage(file, before, after, coAuthors = []) {
  const { added, removed } = lineCounts(before, after);
  return `Live edit ${file}: +${added} -${removed} lines${trailers(coAuthors)}\n`;
}

export function conflictMessage(file, before, after, mainCommit, coAuthors = []) {
  const { added, removed } = lineCounts(before, after);
  return `Conflict copy of ${file}: +${added} -${removed} lines\n\nThe live edit overlapped ${mainCommit} on main. main kept its version;\nthis commit holds the complete live text from before the merge.${trailers(coAuthors)}\n`;
}

export function orphanMessage(file, mainCommit) {
  return `Unsaved copy of ${file}\n\nText from an editor whose live document no longer exists on the service.\nIt was not merged; main was at ${mainCommit}.\n`;
}

const slug = (s) => String(s).normalize('NFKD').replace(/[^A-Za-z0-9._]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').replace(/\.{2,}/g, '.').toLowerCase() || 'unknown';

/** conflict/<user>/<path with slashes replaced>-<UTC timestamp> */
export function conflictBranch(user, file, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('.', '');
  const flat = file.split('/').map((p) => slug(p)).join('_');
  return `conflict/${slug(user)}/${flat}-${stamp}`;
}
