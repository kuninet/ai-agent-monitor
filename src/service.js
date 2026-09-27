#!/usr/bin/env node
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVICE_LABEL = 'com.kuninet.ai-agent-monitor';
export const SERVICE_PORT = 4777;

/**
 * OS に応じた安定版配置ディレクトリのパスを返す
 */
export function getStableDir(platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'ai-agent-monitor');
  }
  return path.join(home, '.local', 'share', 'ai-agent-monitor');
}

/**
 * ログディレクトリのパスを返す
 */
export function getLogDir(home = os.homedir()) {
  return path.join(home, '.ai-status');
}

/**
 * macOS の LaunchAgent plist ファイルパスを返す
 */
export function getLaunchAgentPlistPath(home = os.homedir()) {
  return path.join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

/**
 * macOS LaunchAgent の plist XML 文字列を生成する
 */
export function generateLaunchAgentPlist({
  nodePath,
  serverScriptPath,
  workingDir,
  stdoutPath,
  stderrPath,
  label = SERVICE_LABEL,
}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>--no-warnings=ExperimentalWarning</string>
        <string>${serverScriptPath}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${workingDir}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${stdoutPath}</string>
    <key>StandardErrorPath</key>
    <string>${stderrPath}</string>
</dict>
</plist>
`;
}

/**
 * Windows 用: バックグラウンド実行用 VBScript 文字列を生成する
 */
export function generateVbsScript({ nodePath, serverScript, stdoutPath, stderrPath }) {
  return `Set WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run "cmd.exe /c """"" & "${nodePath}"" --no-warnings=ExperimentalWarning """ & "${serverScript}"" 1>>""" & "${stdoutPath}"" 2>>""" & "${stderrPath}""""", 0, False\r\n`;
}

/**
 * ディレクトリを再帰的にコピーする（不要ファイルは除外）
 */
function copyDirRecursive(
  src,
  dest,
  ignoreNames = new Set(['.git', 'node_modules', 'tests', 'test-results', 'playwright-report']),
) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    if (ignoreNames.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath, ignoreNames);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * 開発リポジトリの稼働ファイルを安定版ディレクトリへ同期する
 */
export function syncToStableDir(srcRepoRoot, stableDir) {
  fs.mkdirSync(stableDir, { recursive: true });

  // 必要なディレクトリとファイルをコピー
  const copyItems = ['src', 'public', 'package.json', 'package-lock.json', 'LICENSE', 'README.md'];
  for (const item of copyItems) {
    const srcPath = path.join(srcRepoRoot, item);
    const destPath = path.join(stableDir, item);
    if (!fs.existsSync(srcPath)) continue;

    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }

  // 安定版ディレクトリで本番用依存パッケージをインストール
  console.log('依存パッケージを配置中 (npm install --omit=dev)...');
  try {
    execSync('npm install --omit=dev', { cwd: stableDir, stdio: 'inherit' });
  } catch (e) {
    console.warn(`npm install 実行時の警告: ${e.message}`);
  }
}

/**
 * macOS 用: サービスのインストール・起動
 */
function installMac(repoRoot, stableDir) {
  const home = os.homedir();
  const logDir = getLogDir(home);
  fs.mkdirSync(logDir, { recursive: true });

  const plistPath = getLaunchAgentPlistPath(home);
  const plistDir = path.dirname(plistPath);
  fs.mkdirSync(plistDir, { recursive: true });

  const nodePath = process.execPath;
  const serverScriptPath = path.join(stableDir, 'src', 'server.js');
  const stdoutPath = path.join(logDir, 'server.log');
  const stderrPath = path.join(logDir, 'server.err.log');

  const plistContent = generateLaunchAgentPlist({
    nodePath,
    serverScriptPath,
    workingDir: stableDir,
    stdoutPath,
    stderrPath,
  });

  fs.writeFileSync(plistPath, plistContent, 'utf8');
  console.log(`設定ファイルを作成しました: ${plistPath}`);

  const uid = process.getuid ? process.getuid() : null;
  if (uid != null) {
    try {
      execSync(`launchctl bootout gui/${uid}/${SERVICE_LABEL} 2>/dev/null || true`);
      execSync(`launchctl bootstrap gui/${uid} "${plistPath}"`);
      console.log('macOS LaunchAgent を登録・起動しました。');
    } catch {
      // 古い launchctl load 形式へのフォールバック
      try {
        execSync(`launchctl unload "${plistPath}" 2>/dev/null || true`);
        execSync(`launchctl load "${plistPath}"`);
        console.log('macOS LaunchAgent を登録・起動しました。');
      } catch (e) {
        console.error(`サービスの登録に失敗しました: ${e.message}`);
      }
    }
  }
}

/**
 * macOS 用: サービスの再起動
 */
function restartMac() {
  const uid = process.getuid ? process.getuid() : null;
  if (uid != null) {
    try {
      execSync(`launchctl kickstart -k gui/${uid}/${SERVICE_LABEL}`);
      console.log('サービスを再起動しました。');
      return;
    } catch {
      // 未起動または kickstart 失敗時は reload を試みる
    }
  }
  const plistPath = getLaunchAgentPlistPath();
  if (fs.existsSync(plistPath)) {
    try {
      execSync(`launchctl unload "${plistPath}" 2>/dev/null || true`);
      execSync(`launchctl load "${plistPath}"`);
      console.log('サービスを再起動しました。');
    } catch (e) {
      console.error(`再起動に失敗しました: ${e.message}`);
    }
  } else {
    console.error('サービスが登録されていません。先に install を実行してください。');
  }
}

/**
 * macOS 用: サービスのアンインストール
 */
function uninstallMac() {
  const home = os.homedir();
  const plistPath = getLaunchAgentPlistPath(home);
  const uid = process.getuid ? process.getuid() : null;

  if (uid != null) {
    try {
      execSync(`launchctl bootout gui/${uid}/${SERVICE_LABEL} 2>/dev/null || true`);
    } catch {}
  }
  if (fs.existsSync(plistPath)) {
    try {
      execSync(`launchctl unload "${plistPath}" 2>/dev/null || true`);
      fs.unlinkSync(plistPath);
      console.log(`設定ファイルを削除しました: ${plistPath}`);
    } catch (e) {
      console.error(`サービスの解除に失敗しました: ${e.message}`);
    }
  }
  console.log('macOS サービスを停止・解除しました。');
}

/**
 * Windows 用: サービスのインストール・起動
 */
function installWindows(repoRoot, stableDir) {
  const home = os.homedir();
  const logDir = getLogDir(home);
  fs.mkdirSync(logDir, { recursive: true });

  const nodePath = process.execPath;
  const serverScript = path.join(stableDir, 'src', 'server.js');
  const stdoutPath = path.join(logDir, 'server.log');
  const stderrPath = path.join(logDir, 'server.err.log');

  // バックグラウンド起動用 vbs スクリプトを生成 (コンソール画面のポップアップ防止)
  const vbsPath = path.join(stableDir, 'run-service.vbs');
  const vbsContent = generateVbsScript({ nodePath, serverScript, stdoutPath, stderrPath });
  fs.writeFileSync(vbsPath, vbsContent, 'utf8');

  // タスクスケジューラに登録 (ログオン時実行)
  try {
    execSync(`schtasks /create /sc onlogon /tn "${SERVICE_LABEL}" /tr "wscript.exe \\"${vbsPath}\\"" /f`, {
      stdio: 'inherit',
    });
    execSync(`schtasks /run /tn "${SERVICE_LABEL}"`, { stdio: 'inherit' });
    console.log('Windows タスクを登録・起動しました。');
  } catch (e) {
    console.error(`タスクの登録に失敗しました: ${e.message}`);
  }
}

/**
 * Windows 用: サービスの再起動
 */
function restartWindows(stableDir) {
  const vbsPath = path.join(stableDir, 'run-service.vbs');
  try {
    execSync(`schtasks /end /tn "${SERVICE_LABEL}"`, { stdio: 'ignore' });
  } catch {
    // タスクが未起動等のエラーは安全に無視
  }

  try {
    execSync(`schtasks /run /tn "${SERVICE_LABEL}"`, { stdio: 'inherit' });
    console.log('サービスを再起動しました。');
  } catch (e) {
    if (fs.existsSync(vbsPath)) {
      execSync(`wscript.exe "${vbsPath}"`);
      console.log('サービスを起動しました。');
    } else {
      console.error(`再起動に失敗しました: ${e.message}`);
    }
  }
}

/**
 * Windows 用: サービスのアンインストール
 */
function uninstallWindows() {
  try {
    execSync(`schtasks /end /tn "${SERVICE_LABEL}"`, { stdio: 'ignore' });
  } catch {
    // タスクが未起動等のエラーは安全に無視
  }

  try {
    execSync(`schtasks /delete /tn "${SERVICE_LABEL}" /f`, { stdio: 'inherit' });
    console.log('Windows タスクを停止・解除しました。');
  } catch (e) {
    console.error(`タスクの解除に失敗しました: ${e.message}`);
  }
}

/**
 * 稼働状態の確認
 */
function printStatus(stableDir) {
  console.log('=== AI Agent Monitor サービス状態 ===');
  console.log(`安定版ディレクトリ: ${stableDir}`);
  console.log(`安定版コードの存在: ${fs.existsSync(stableDir) ? 'あり' : 'なし'}`);

  const logDir = getLogDir();
  console.log(`ログディレクトリ: ${logDir}`);

  if (process.platform === 'darwin') {
    const plistPath = getLaunchAgentPlistPath();
    console.log(`LaunchAgent plist: ${fs.existsSync(plistPath) ? plistPath : '未登録'}`);
  } else if (process.platform === 'win32') {
    try {
      const out = execSync(`schtasks /query /tn "${SERVICE_LABEL}" 2>nul`, { encoding: 'utf8' });
      console.log(`Windows タスク: 登録済み\n${out.trim()}`);
    } catch {
      console.log('Windows タスク: 未登録');
    }
  }

  // ポート 4777 の確認
  try {
    if (process.platform === 'win32') {
      const netstat = execSync('netstat -ano | findstr :4777', { encoding: 'utf8' });
      console.log(`ポート 4777: 稼働中\n${netstat.trim()}`);
    } else {
      const lsof = execSync('lsof -i :4777', { encoding: 'utf8' });
      console.log(`ポート 4777: 稼働中\n${lsof.trim()}`);
    }
  } catch {
    console.log('ポート 4777: 停止中');
  }
}

/**
 * メインエントリーポイント
 */
export function runServiceCli(args = process.argv.slice(2)) {
  const action = args[0] || 'status';
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const stableDir = getStableDir();

  switch (action) {
    case 'install': {
      console.log(`安定版ディレクトリへ同期中: ${stableDir}`);
      syncToStableDir(repoRoot, stableDir);
      if (process.platform === 'darwin') {
        installMac(repoRoot, stableDir);
      } else if (process.platform === 'win32') {
        installWindows(repoRoot, stableDir);
      } else {
        console.log(`Linux 環境では ${stableDir} への配置が完了しました。systemd 等で登録してください。`);
      }
      break;
    }
    case 'deploy': {
      console.log(`最新コードを安定版へデプロイ中: ${stableDir}`);
      syncToStableDir(repoRoot, stableDir);
      console.log('サービスを再起動中...');
      if (process.platform === 'darwin') {
        restartMac();
      } else if (process.platform === 'win32') {
        restartWindows(stableDir);
      }
      break;
    }
    case 'restart': {
      if (process.platform === 'darwin') {
        restartMac();
      } else if (process.platform === 'win32') {
        restartWindows(stableDir);
      } else {
        console.log('この OS では手動で再起動してください。');
      }
      break;
    }
    case 'uninstall': {
      if (process.platform === 'darwin') {
        uninstallMac();
      } else if (process.platform === 'win32') {
        uninstallWindows();
      } else {
        console.log('この OS では手動で解除してください。');
      }
      break;
    }
    case 'status': {
      printStatus(stableDir);
      break;
    }
    default: {
      console.log('使い方: node src/service.js <install|uninstall|restart|deploy|status>');
      process.exit(1);
    }
  }
}

// 直接実行された場合
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runServiceCli();
}
