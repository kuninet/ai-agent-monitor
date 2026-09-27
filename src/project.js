import fs from 'node:fs';
import path from 'node:path';

// キャッシュ: cwd -> { projectKey, projectName, expiresAt }
const projectCache = new Map();
const NEGATIVE_CACHE_TTL_MS = 60_000; // gitルートが見つからなかった場合のキャッシュ期間(1分)
const POSITIVE_CACHE_TTL_MS = 3_600_000; // 見つかった場合のキャッシュ期間(1時間)

/**
 * gitdir パスが `.../.git/worktrees/<名前>` の形かどうかを判定し、
 * 本体のリポジトリルートのパスを返す。一致しなければ null を返す。
 */
export function extractWorktreeMainRepo(gitDirRaw, gitFileDir) {
  if (!gitDirRaw) return null;
  const trimmed = gitDirRaw.trim();
  if (!trimmed) return null;

  // 相対パスの場合は .git ファイルがあるディレクトリ基準で解決
  const resolved = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(gitFileDir, trimmed);

  // パス区切りをスラッシュに統一して判定 (Windows パス対応)
  const normalized = resolved.replace(/\\/g, '/');
  const match = normalized.match(/^(.*?)\/\.git\/worktrees\/[^/]+(?:\/)?$/i);
  if (match && match[1]) {
    // Windows の C: のようなドライブレター形式も元の OS の区切り文字に戻す
    const mainRepoPath = match[1];
    return path.normalize(mainRepoPath);
  }
  return null;
}

/**
 * 指定されたディレクトリから親を辿り、リポジトリのルートを探す。
 * 見つからない場合は null を返す。
 */
function findRepoRoot(startDir) {
  let current = path.resolve(startDir);

  while (true) {
    const gitPath = path.join(current, '.git');
    try {
      const stat = fs.statSync(gitPath);
      if (stat.isDirectory()) {
        return current;
      }
      if (stat.isFile()) {
        const content = fs.readFileSync(gitPath, 'utf8');
        const match = content.match(/^gitdir:\s*(.+)$/m);
        if (match) {
          const mainRepo = extractWorktreeMainRepo(match[1], current);
          if (mainRepo) {
            return mainRepo;
          }
        }
        // worktree 以外の .git ファイル(サブモジュール等)は、この .git を含むディレクトリをルートとする
        return current;
      }
    } catch {
      // 存在しないか読み取れない場合は親ディレクトリへ
    }

    const parent = path.dirname(current);
    if (parent === current) {
      // ファイルシステムのルートに到達
      break;
    }
    current = parent;
  }

  return null;
}

/**
 * cwd から projectKey と projectName を解決する。
 *
 * @param {string} cwd - セッションの作業ディレクトリ
 * @param {object} [options]
 * @param {number} [options.now] - 現在時刻 (ミリ秒, テスト用)
 * @returns {{ projectKey: string, projectName: string }}
 */
export function resolveProject(cwd, options = {}) {
  if (!cwd || typeof cwd !== 'string') {
    return { projectKey: '', projectName: '' };
  }

  const now = options.now ?? Date.now();
  const cached = projectCache.get(cwd);
  if (cached && cached.expiresAt > now) {
    return { projectKey: cached.projectKey, projectName: cached.projectName };
  }

  const repoRoot = findRepoRoot(cwd);
  let projectKey;
  let projectName;
  let ttl;

  if (repoRoot) {
    projectKey = repoRoot;
    projectName = path.basename(repoRoot) || repoRoot;
    ttl = POSITIVE_CACHE_TTL_MS;
  } else {
    // git 管理外、ディレクトリが消えている、読み取れない場合
    projectKey = cwd;
    projectName = path.basename(cwd) || cwd;
    ttl = NEGATIVE_CACHE_TTL_MS;
  }

  projectCache.set(cwd, {
    projectKey,
    projectName,
    expiresAt: now + ttl,
  });

  return { projectKey, projectName };
}

/**
 * キャッシュをクリアする (テスト用)
 */
export function clearProjectCache() {
  projectCache.clear();
}
