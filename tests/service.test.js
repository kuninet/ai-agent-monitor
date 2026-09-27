import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  SERVICE_LABEL,
  getStableDir,
  getLogDir,
  getLaunchAgentPlistPath,
  generateLaunchAgentPlist,
  generateVbsScript,
} from '../src/service.js';

describe('service.js', () => {
  test('getStableDir returns correct paths per platform without hardcoded usernames', () => {
    const fakeHome = '/Users/testuser';

    const macDir = getStableDir('darwin', fakeHome);
    assert.equal(macDir, path.join(fakeHome, '.local', 'share', 'ai-agent-monitor'));

    const linuxDir = getStableDir('linux', fakeHome);
    assert.equal(linuxDir, path.join(fakeHome, '.local', 'share', 'ai-agent-monitor'));

    const winHome = 'C:\\Users\\testuser';
    const winDir = getStableDir('win32', winHome);
    assert.ok(winDir.toLowerCase().includes('ai-agent-monitor'));
  });

  test('getLogDir returns path under ~/.ai-status', () => {
    const fakeHome = '/Users/testuser';
    const logDir = getLogDir(fakeHome);
    assert.equal(logDir, path.join(fakeHome, '.ai-status'));
  });

  test('getLaunchAgentPlistPath returns correct plist location', () => {
    const fakeHome = '/Users/testuser';
    const plistPath = getLaunchAgentPlistPath(fakeHome);
    assert.equal(plistPath, path.join(fakeHome, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`));
  });

  test('generateLaunchAgentPlist produces valid XML structure and values', () => {
    const params = {
      nodePath: '/usr/local/bin/node',
      serverScriptPath: '/Users/testuser/.local/share/ai-agent-monitor/src/server.js',
      workingDir: '/Users/testuser/.local/share/ai-agent-monitor',
      stdoutPath: '/Users/testuser/.ai-status/server.log',
      stderrPath: '/Users/testuser/.ai-status/server.err.log',
      label: SERVICE_LABEL,
    };

    const plist = generateLaunchAgentPlist(params);

    assert.ok(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(plist.includes(`<string>${SERVICE_LABEL}</string>`));
    assert.ok(plist.includes('<string>/usr/local/bin/node</string>'));
    assert.ok(plist.includes(`<string>${params.serverScriptPath}</string>`));
    assert.ok(plist.includes(`<string>${params.workingDir}</string>`));
    assert.ok(plist.includes(`<string>${params.stdoutPath}</string>`));
    assert.ok(plist.includes(`<string>${params.stderrPath}</string>`));
    assert.ok(plist.includes('<key>RunAtLoad</key>\n    <true/>'));
    assert.ok(plist.includes('<key>KeepAlive</key>\n    <true/>'));
  });

  test('generateVbsScript produces valid VBScript with cmd.exe and correct paths', () => {
    const params = {
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      serverScript: 'C:\\Users\\testuser\\AppData\\Roaming\\ai-agent-monitor\\src\\server.js',
      stdoutPath: 'C:\\Users\\testuser\\.ai-status\\server.log',
      stderrPath: 'C:\\Users\\testuser\\.ai-status\\server.err.log',
    };

    const vbs = generateVbsScript(params);

    assert.ok(vbs.includes('Set WshShell = CreateObject("WScript.Shell")'));
    assert.ok(vbs.includes('cmd.exe /c'));
    assert.ok(vbs.includes(params.nodePath));
    assert.ok(vbs.includes(params.serverScript));
    assert.ok(vbs.includes(params.stdoutPath));
    assert.ok(vbs.includes(params.stderrPath));
    assert.ok(vbs.includes('--no-warnings=ExperimentalWarning'));
    assert.ok(vbs.endsWith(', 0, False\r\n'));
  });
});
