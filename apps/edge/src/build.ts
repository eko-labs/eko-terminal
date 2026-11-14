import { existsSync, readFileSync } from 'node:fs';

/**
 * Which commit this process runs, so anyone can check the live site against the code (GET /health → build).
 * `scripts/deploy-edge.mjs` writes apps/edge/build.json from a clean checkout just before `railway up` and removes it
 * after; BUILD_COMMIT is the fallback for other hosts. Without either, commit is null and the post-deploy check fails.
 */
export interface BuildInfo { commit: string | null; builtAt: string | null }

export function loadBuild(file = new URL('../build.json', import.meta.url), env: NodeJS.ProcessEnv = process.env): BuildInfo {
  try {
    if (existsSync(file)) {
      const b = JSON.parse(readFileSync(file, 'utf8')) as { commit?: unknown; builtAt?: unknown };
      if (typeof b.commit === 'string' && /^[0-9a-f]{40}$/.test(b.commit)) return { commit: b.commit, builtAt: typeof b.builtAt === 'string' ? b.builtAt : null };
    }
  } catch { /* fall through to the environment */ }
  const commit = env.BUILD_COMMIT && /^[0-9a-f]{40}$/.test(env.BUILD_COMMIT) ? env.BUILD_COMMIT : null;
  return { commit, builtAt: null };
}
