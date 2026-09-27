import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveProject, clearProjectCache, extractWorktreeMainRepo } from '../src/project.js';

describe('project.js - extractWorktreeMainRepo', () => {
  test('POSIX worktree gitdir', () => {
    const gitDir = '/home/user/repo/.git/worktrees/feature-x';
    const main = extractWorktreeMainRepo(gitDir, '/home/user/worktree-x');
    assert.equal(main, '/home/user/repo');
  });

  test('Windows worktree gitdir with forward slashes', () => {
    const gitDir = 'C:/Users/user/repo/.git/worktrees/feature-x';
    const main = extractWorktreeMainRepo(gitDir, 'C:/Users/user/worktree-x');
    // path.normalize on POSIX will preserve or adjust slashes, normalized check
    assert.ok(main.replace(/\\/g, '/').toLowerCase().includes('c:/users/user/repo'));
  });

  test('Windows worktree gitdir with backslashes', () => {
    const gitDir = 'C:\\Users\\user\\repo\\.git\\worktrees\\feature-x';
    const main = extractWorktreeMainRepo(gitDir, 'C:\\Users\\user\\worktree-x');
    assert.ok(main.replace(/\\/g, '/').toLowerCase().includes('c:/users/user/repo'));
  });

  test('Submodule gitdir is not treated as worktree', () => {
    const gitDir = '../.git/modules/submodule-a';
    const main = extractWorktreeMainRepo(gitDir, '/home/user/repo/sub');
    assert.equal(main, null);
  });
});

describe('project.js - resolveProject', () => {
  let tempDir;

  beforeEach(() => {
    clearProjectCache();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-test-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    clearProjectCache();
  });

  test('空の cwd の場合、projectKey も projectName も空文字', () => {
    assert.deepEqual(resolveProject(''), { projectKey: '', projectName: '' });
    assert.deepEqual(resolveProject(null), { projectKey: '', projectName: '' });
    assert.deepEqual(resolveProject(undefined), { projectKey: '', projectName: '' });
  });

  test('存在しない cwd の場合、cwd 自体が projectKey になり projectName は basename', () => {
    const nonExistent = path.join(tempDir, 'does-not-exist', 'sub');
    const res = resolveProject(nonExistent);
    assert.equal(res.projectKey, nonExistent);
    assert.equal(res.projectName, 'sub');
  });

  test('git 管理外のディレクトリの場合、cwd が projectKey になる', () => {
    const noGitDir = path.join(tempDir, 'plain-project', 'deep', 'folder');
    fs.mkdirSync(noGitDir, { recursive: true });

    const res = resolveProject(noGitDir);
    assert.equal(res.projectKey, noGitDir);
    assert.equal(res.projectName, 'folder');
  });

  test('通常のリポジトリ (.git ディレクトリ) の場合、親をたどってリポジトリルートを検出', () => {
    const repoRoot = path.join(tempDir, 'my-repo');
    const subDir = path.join(repoRoot, 'src', 'utils');
    fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
    fs.mkdirSync(subDir, { recursive: true });

    const res = resolveProject(subDir);
    assert.equal(res.projectKey, repoRoot);
    assert.equal(res.projectName, 'my-repo');
  });

  test('git worktree (.git ファイル) の場合、本体のリポジトリルートを検出', () => {
    const mainRepo = path.join(tempDir, 'main-repo');
    const worktreeDir = path.join(tempDir, 'worktree-feature');
    fs.mkdirSync(path.join(mainRepo, '.git', 'worktrees', 'worktree-feature'), { recursive: true });
    fs.mkdirSync(worktreeDir, { recursive: true });

    // .git ファイルを作成
    const gitDirTarget = path.join(mainRepo, '.git', 'worktrees', 'worktree-feature');
    fs.writeFileSync(path.join(worktreeDir, '.git'), `gitdir: ${gitDirTarget}\n`);

    const subDir = path.join(worktreeDir, 'deep', 'dir');
    fs.mkdirSync(subDir, { recursive: true });

    const res = resolveProject(subDir);
    assert.equal(res.projectKey, mainRepo);
    assert.equal(res.projectName, 'main-repo');
  });

  test('サブモジュール (.git ファイル) の場合、その .git があるディレクトリをルートとする', () => {
    const mainRepo = path.join(tempDir, 'main-repo');
    const subModuleDir = path.join(mainRepo, 'vendor', 'lib');
    fs.mkdirSync(path.join(mainRepo, '.git', 'modules', 'vendor', 'lib'), { recursive: true });
    fs.mkdirSync(subModuleDir, { recursive: true });

    fs.writeFileSync(
      path.join(subModuleDir, '.git'),
      `gitdir: ${path.join(mainRepo, '.git', 'modules', 'vendor', 'lib')}\n`,
    );

    const deepSub = path.join(subModuleDir, 'src');
    fs.mkdirSync(deepSub, { recursive: true });

    const res = resolveProject(deepSub);
    assert.equal(res.projectKey, subModuleDir);
    assert.equal(res.projectName, 'lib');
  });

  test('キャッシュの動作: 成功結果は保持、失敗結果は短いTTL', () => {
    let now = 1000000;
    const targetDir = path.join(tempDir, 'dynamically-created');

    // まだ存在しない状態 -> 失敗キャッシュ
    const res1 = resolveProject(targetDir, { now });
    assert.equal(res1.projectKey, targetDir);

    // その直後に .git を作っても、キャッシュ期間内(60s未満)ならキャッシュを返す
    fs.mkdirSync(path.join(targetDir, '.git'), { recursive: true });
    const res2 = resolveProject(targetDir, { now: now + 30000 });
    assert.equal(res2.projectKey, targetDir); // まだ失敗キャッシュ

    // 60s 経過後は再探索され、リポジトリが検出される
    const res3 = resolveProject(targetDir, { now: now + 65000 });
    assert.equal(res3.projectKey, targetDir);
    assert.equal(res3.projectName, 'dynamically-created');
  });
});
