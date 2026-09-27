import { test, expect } from '@playwright/test';

test.describe('AI Agent Monitor - Issue 20 UI Tests', () => {
  test.beforeEach(async ({ page }) => {
    // ローカルストレージをクリアして初期状態で開く
    await page.goto('/?mock=1');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  });

  test('初期表示: まとめ方なし、全列表示、質問表プロジェクト列、タスク表プロジェクト名', async ({ page }) => {
    // セッション表の列数 (15列)
    const sessionHeaders = page.locator('#sessions-body thead th');
    await expect(sessionHeaders).toHaveCount(15);
    await expect(sessionHeaders.nth(4)).toHaveText('プロジェクト');

    // 質問表の列に「プロジェクト」が存在すること
    const questionHeaders = page.locator('#questions-body thead th');
    await expect(questionHeaders.nth(2)).toHaveText('プロジェクト');
    const firstQuestionProject = page.locator('#questions-body tbody tr').first().locator('td').nth(2);
    await expect(firstQuestionProject).not.toBeEmpty();

    // タスク表のグループ見出しにプロジェクト名バッジが表示されること
    const taskProjectBadge = page.locator('.task-group-project').first();
    await expect(taskProjectBadge).toBeVisible();

    // まとめ方ボタンの初期状態
    const btnNone = page.locator('button[data-group-mode="none"]');
    const btnProject = page.locator('button[data-group-mode="project"]');
    await expect(btnNone).toHaveClass(/active/);
    await expect(btnProject).not.toHaveClass(/active/);
  });

  test('プロジェクトまとめ表示: 切り替え、グループ見出し、worktreeの統合、保存', async ({ page }) => {
    // プロジェクトまとめに切り替え
    const btnProject = page.locator('button[data-group-mode="project"]');
    await btnProject.click();
    await expect(btnProject).toHaveClass(/active/);

    // グループ見出しが存在すること
    const groupHeaders = page.locator('#sessions-body tr.session-group-header');
    await expect(groupHeaders.first()).toBeVisible();

    // ai-agent-monitor グループを探す
    const aiAgentGroup = groupHeaders.filter({ hasText: 'ai-agent-monitor' });
    await expect(aiAgentGroup).toBeVisible();
    await expect(aiAgentGroup).toHaveAttribute('title', '/Users/dev/git/ai-agent-monitor');

    // 件数と作業時間が出ていること
    const meta = aiAgentGroup.locator('.session-group-meta');
    await expect(meta).toContainText('件');
    const work = aiAgentGroup.locator('.session-group-work');
    await expect(work).toContainText('作業時間');

    // ページをリロードしても「プロジェクト」まとめが保持されること
    await page.reload();
    await expect(page.locator('button[data-group-mode="project"]')).toHaveClass(/active/);
    await expect(page.locator('#sessions-body tr.session-group-header').first()).toBeVisible();
  });

  test('プロジェクトグループの開閉', async ({ page }) => {
    await page.locator('button[data-group-mode="project"]').click();
    const firstGroup = page.locator('#sessions-body tr.session-group-header').first();
    const toggleBtn = firstGroup.locator('.session-group-toggle');
    await expect(toggleBtn).toHaveText('▾');

    // 折りたたむ
    await toggleBtn.click();
    await expect(toggleBtn).toHaveText('▸');

    // 展開する
    await toggleBtn.click();
    await expect(toggleBtn).toHaveText('▾');
  });

  test('まとめているときのセッション行クリックによる絞り込みと、見出しクリックの無視', async ({ page }) => {
    await page.locator('button[data-group-mode="project"]').click();

    // 見出し行をクリックしても絞り込みバナーは出ないこと
    const firstGroup = page.locator('#sessions-body tr.session-group-header').first();
    await firstGroup.click();
    await expect(page.locator('#questions-filter-banner')).toBeEmpty();

    // セッション行をクリックすると絞り込みが有効になること
    const firstSessionRow = page.locator('#sessions-body tr.session-row').first();
    await firstSessionRow.click();
    await expect(page.locator('#questions-filter-banner')).toContainText('だけを表示中');

    // もう一度クリックすると解除されること
    await firstSessionRow.click();
    await expect(page.locator('#questions-filter-banner')).toBeEmpty();
  });

  test('列の表示・非表示切り替え、colspanの動的計算、設定の保持', async ({ page }) => {
    // 初期状態の列数: 15
    await expect(page.locator('#sessions-body thead th')).toHaveCount(15);

    // 設定パネルを開く
    await page.locator('#settings-btn').click();
    const settingsPanel = page.locator('#settings-panel');
    await expect(settingsPanel).toBeVisible();

    // プロジェクト列のチェックボックスを外す
    const projectColCheckbox = settingsPanel.locator('input[data-column-id="project"]');
    await expect(projectColCheckbox).toBeChecked();
    await projectColCheckbox.click();
    await expect(projectColCheckbox).not.toBeChecked();

    // セッション表の列数が 14 に減ること
    await expect(page.locator('#sessions-body thead th')).toHaveCount(14);

    // プロジェクトまとめに切り替えて見出し行の colspan が 14 になっていること
    await page.locator('button[data-group-mode="project"]').click();
    const groupHeaderCell = page.locator('#sessions-body tr.session-group-header td').first();
    await expect(groupHeaderCell).toHaveAttribute('colspan', '14');

    // サブエージェントを開き、サブエージェント子行の colspan も 14 になっていること
    const saToggle = page.locator('#sessions-body .sa-toggle').first();
    if (await saToggle.isVisible()) {
      await saToggle.click();
      const subagentCell = page.locator('#sessions-body tr.subagent-row td').first();
      await expect(subagentCell).toHaveAttribute('colspan', '14');
    }

    // リロードしても列非表示設定が維持されること
    await page.reload();
    await expect(page.locator('#sessions-body thead th')).toHaveCount(14);
  });

  test('レスポンシブ表示: 375px 幅でページ全体が横スクロールしないこと', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.locator('button[data-group-mode="project"]').click();

    const isHorizontalScrollable = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    expect(isHorizontalScrollable).toBe(false);
  });
});
