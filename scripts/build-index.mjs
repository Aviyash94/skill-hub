// Builds src/data/skills.json from the allowlist in data/sources.yaml.
// Usage: GITHUB_TOKEN=... node scripts/build-index.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parse } from 'yaml';

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const TOKEN = process.env.GITHUB_TOKEN;
const OK_LICENSES = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'Unlicense', 'CC0-1.0', '0BSD']);

const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'skills-hub-indexer' };
if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

async function gh(path) {
  const res = await fetch(`${API}${path}`, { headers });
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`);
  return res.json();
}

function parseFrontmatter(text) {
  const m = text.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) throw new Error('no frontmatter');
  const fm = parse(m[1]);
  if (!fm || typeof fm.name !== 'string' || typeof fm.description !== 'string') {
    throw new Error('frontmatter needs string name and description');
  }
  return fm;
}

const NAMES = [
  [/^mit$/i, 'MIT'], [/^apache[-\s]?(2(\.0)?|license.*2)/i, 'Apache-2.0'], [/^bsd-3/i, 'BSD-3-Clause'], [/^bsd-2/i, 'BSD-2-Clause'], [/^isc$/i, 'ISC'],
];
const fromName = (t) => NAMES.find(([re]) => re.test(String(t).trim()))?.[1];

// Per-skill license: frontmatter `license`, else a LICENSE* file in the skill folder.
async function skillLicense(repo, ref, dir, tree, fm) {
  const named = fromName(fm.license ?? '');
  if (named) return named;
  const lic = tree.find((t) => t.type === 'blob' && t.path.startsWith(dir ? dir + '/' : '') && /^LICENSE(\.\w+)?$/i.test(t.path.slice(dir ? dir.length + 1 : 0)));
  if (!lic) return null;
  const res = await fetch(`${RAW}/${repo}/${ref}/${lic.path}`);
  if (!res.ok) return null;
  const text = (await res.text()).slice(0, 600);
  if (/Apache License/i.test(text)) return 'Apache-2.0';
  if (/^\s*MIT License/i.test(text)) return 'MIT';
  return null;
}

const config = parse(await readFile('data/sources.yaml', 'utf8'));
const categories = new Set(config.categories);
const skills = [];
const skipped = [];
const repos = [];
const failedRepos = [];

for (const src of config.sources) {
  const { repo } = src;
  try {
    const meta = await gh(`/repos/${repo}`);
    const spdx = meta.license?.spdx_id;
    const repoOk = OK_LICENSES.has(spdx);
    // No clear repo-level license: fall back to a per-skill license check below.
    if (!repoOk && !src.perSkillLicense) {
      skipped.push({ repo, reason: `license not permissive/clear: ${spdx ?? 'none'} (set perSkillLicense: true to check each skill)` });
      console.warn(`SKIP repo ${repo}: license ${spdx ?? 'none'}`);
      continue;
    }
    const ref = src.ref ?? meta.default_branch;
    const tree = await gh(`/repos/${repo}/git/trees/${ref}?recursive=1`);
    const commit = tree.sha;
    const files = tree.tree.filter(
      (f) => f.type === 'blob' && /(^|\/)SKILL\.md$/.test(f.path) && !(src.exclude ?? []).some((p) => f.path.startsWith(p)),
    );
    repos.push({ repo, stars: meta.stargazers_count, license: spdx, pushedAt: meta.pushed_at });

    for (const f of files) {
      try {
        const res = await fetch(`${RAW}/${repo}/${ref}/${f.path}`);
        if (!res.ok) throw new Error(`raw ${res.status}`);
        const fm = parseFrontmatter(await res.text());
        const dirPath = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
        const license = repoOk ? spdx : await skillLicense(repo, ref, dirPath, tree.tree, fm);
        if (!license) throw new Error('no clear permissive license for this skill');
        // Precedence: repo defaults < matching rules (in order) < per-skill overrides.
        let category = src.category ?? 'Other';
        const tagSet = new Set(src.tags ?? []);
        for (const r of src.rules ?? []) {
          if (r.path && !new RegExp(r.path, 'i').test(f.path)) continue;
          if (r.name && !new RegExp(r.name, 'i').test(fm.name)) continue;
          if (!r.path && !r.name) continue;
          if (r.category) category = r.category;
          (r.tags ?? []).forEach((t) => tagSet.add(t));
        }
        const ov = src.overrides?.[fm.name] ?? {};
        if (ov.category) category = ov.category;
        (ov.tags ?? []).forEach((t) => tagSet.add(t));
        if (!categories.has(category)) throw new Error(`unknown category "${category}"`);
        const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
        skills.push({
          id: `${repo}/${fm.name}`.toLowerCase(),
          name: fm.name,
          description: fm.description.trim(),
          repo,
          path: f.path,
          url: `https://github.com/${repo}/tree/${ref}/${dir}`,
          category,
          tags: [...tagSet].sort((a, b) => a.localeCompare(b)),
          license,
          stars: meta.stargazers_count,
          updatedAt: meta.pushed_at,
          treeSha: commit,
          install: `npx skills add https://github.com/${repo} --skill ${fm.name}`,
        });
      } catch (e) {
        skipped.push({ repo, path: f.path, reason: e.message });
        console.warn(`SKIP ${repo}/${f.path}: ${e.message}`);
      }
    }
  } catch (e) {
    skipped.push({ repo, reason: e.message });
    failedRepos.push(repo);
    console.warn(`FAIL repo ${repo}: ${e.message}`);
  }
}

// Never replace a good index with a partial one (e.g. rate limit or network error).
if (failedRepos.length) {
  console.error(`Aborting: could not index ${failedRepos.join(', ')}. Existing src/data/skills.json left untouched.`);
  process.exit(1);
}

// Drop duplicate ids (same skill name twice in one repo): first one wins.
const seen = new Set();
const unique = skills.filter((s) => (seen.has(s.id) ? false : seen.add(s.id)));
unique.sort((a, b) => b.stars - a.stars || a.name.localeCompare(b.name));

await mkdir('src/data', { recursive: true });
await writeFile(
  'src/data/skills.json',
  JSON.stringify({ generatedAt: new Date().toISOString(), categories: config.categories, repos, skills: unique, skipped }, null, 2),
);
const byCat = {};
for (const s of unique) byCat[s.category] = (byCat[s.category] ?? 0) + 1;
console.log('By category:', byCat);
console.log(`"Other" (check for missing rules): ${byCat.Other ?? 0}`);
console.log(`Indexed ${unique.length} skills from ${repos.length} repos; skipped ${skipped.length}.`);
