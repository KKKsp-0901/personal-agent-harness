import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const skillFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'document-knowledge', 'SKILL.md');
let skillText;

export async function documentSkill(section) {
  skillText ??= await fs.readFile(skillFile, 'utf8');
  const heading = `## ${section}`;
  const start = skillText.indexOf(heading);
  if (start < 0) throw new Error(`文档 Skill 缺少章节：${section}`);
  const bodyStart = start + heading.length;
  const end = skillText.indexOf('\n## ', bodyStart);
  return skillText.slice(bodyStart, end < 0 ? undefined : end).trim();
}
