import { existsSync, readFileSync } from 'node:fs';

/**
 * Which commit this process runs, so anyone can check the live site against the code (GET /health → build).
 * Railway deploys each push to main from GitHub and sets RAILWAY_GIT_COMMIT_SHA. A manual `scripts/deploy-edge.mjs`
 * upload writes apps/edge/build.json instead (no git in an upload); BUILD_COMMIT covers other hosts. With none of them,
 * commit is null and the post-deploy check fails.
 */
export interface BuildInfo { commit: string | null; builtAt: string | null }

export function loadBuild(file = new URL('../build.json', import.meta.url), env: NodeJS.ProcessEnv = process.env): BuildInfo {
  try {
    if (existsSync(file)) {
      const b = JSON.parse(readFileSync(file, 'utf8')) as { commit?: unknown; builtAt?: unknown };
      if (typeof b.commit === 'string' && /^[0-9a-f]{40}$/.test(b.commit)) return { commit: b.commit, builtAt: typeof b.builtAt === 'string' ? b.builtAt : null };
    }
  } catch { /* fall through to the environment */ }
  const named = [env.RAILWAY_GIT_COMMIT_SHA, env.BUILD_COMMIT].find(c => c && /^[0-9a-f]{40}$/.test(c));
  const commit = named ?? null;
  return { commit, builtAt: null };
}
