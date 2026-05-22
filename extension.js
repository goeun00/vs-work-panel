const vscode = require("vscode");
const cp = require("child_process");

const SETTINGS_KEY = "jiraWorkPanel.settings";
const ISSUE_META_KEY = "jiraWorkPanel.issueMeta";
const BRANCH_ALIAS_KEY = "jiraWorkPanel.branchAliases";
const SECRET_TOKEN_KEY = "jiraWorkPanel.jiraToken";

const DEFAULT_JQL =
  "(assignee = currentUser() OR watcher = currentUser()) AND " +
  "(statusCategory != Done OR (statusCategory = Done AND updated >= -60d)) " +
  "ORDER BY updated DESC";

// 🔴 보안: Jira 이슈 키 검증
function validateJiraKey(key) {
  if (typeof key !== "string") {
    throw new Error("유효하지 않은 이슈 키입니다");
  }
  if (!/^[A-Z]+-\d+$/.test(key)) {
    throw new Error("유효하지 않은 이슈 키 형식입니다");
  }
  return key;
}

// 🔴 보안: URL 검증
function validateUrl(url) {
  if (typeof url !== "string") {
    throw new Error("유효하지 않은 URL입니다");
  }
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("HTTP(S) URL만 허용됩니다");
    }
    return url;
  } catch {
    throw new Error("유효하지 않은 URL입니다");
  }
}

// 🔴 보안: JQL 검증
function validateJql(jql) {
  if (typeof jql !== "string") {
    throw new Error("유효하지 않은 JQL입니다");
  }
  if (jql.length > 5000) {
    throw new Error("JQL이 너무 깁니다 (최대 5000자)");
  }
  return jql;
}

// 🔴 보안: 브랜치명 검증
function validateBranchName(name) {
  if (typeof name !== "string") {
    throw new Error("유효하지 않은 브랜치명입니다");
  }
  // 경로 탐색 방지
  if (name.includes("..") || name.startsWith("/")) {
    throw new Error("유효하지 않은 브랜치명입니다");
  }
  return name;
}

function activate(context) {
  const provider = new JiraWorkPanelProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("jiraWorkPanel.view", provider),
    vscode.commands.registerCommand("jiraWorkPanel.refresh", () =>
      provider.syncIssues(),
    ),
  );
}

class JiraWorkPanelProvider {
  constructor(context) {
    this.context = context;
    this.view = null;
    this.timer = null;
    this.gitHeadWatcher = null;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    this.watchGitHead();
    webviewView.webview.options = {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ],
    };
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.sendState();
      }
    });
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      const { type, payload = {} } = message || {};

      // 🔴 보안: 메시지 타입 화이트리스트 검증
      const ALLOWED_TYPES = [
        "ready",
        "saveSettings",
        "syncIssues",
        "saveIssueMeta",
        "saveBranchAlias",
        "loadBranches",
        "checkoutBranch",
        "openJira",
        "testJiraConnection",
      ];

      if (!ALLOWED_TYPES.includes(type)) {
        console.error("Unknown message type:", type);
        return;
      }

      if (type === "ready") {
        await this.sendState();
        this.startAutoSync();
      }

      if (type === "saveSettings") {
        await this.saveSettings(payload);
        await this.sendState();
        this.startAutoSync();
      }

      if (type === "syncIssues") {
        await this.syncIssues();
      }

      if (type === "saveIssueMeta") {
        await this.saveIssueMeta(payload);
      }

      if (type === "saveBranchAlias") {
        await this.saveBranchAlias(payload);
        await this.sendState();
      }

      if (type === "loadBranches") {
        await this.sendState();
      }

      if (type === "checkoutBranch") {
        await this.checkoutBranch(payload);
      }

      if (type === "openJira") {
        await this.openJira(payload.key);
      }

      if (type === "testJiraConnection") {
        await this.testJiraConnection();
      }
    });
  }

  getHtml(webview) {
    const htmlPath = vscode.Uri.joinPath(
      this.context.extensionUri,
      "media",
      "webview.html",
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "webview.css"),
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "webview.js"),
    );
    const nonce = getNonce();

    return require("fs")
      .readFileSync(htmlPath.fsPath, "utf8")
      .replace(/\$\{styleUri\}/g, String(styleUri))
      .replace(/\$\{scriptUri\}/g, String(scriptUri))
      .replace(/\$\{nonce\}/g, nonce)
      .replace(/\$\{cspSource\}/g, webview.cspSource);
  }

  getSettings() {
    const saved = this.context.globalState.get(SETTINGS_KEY, {});
    const configBaseUrl = vscode.workspace
      .getConfiguration("jiraWorkPanel")
      .get("jiraBaseUrl");

    return {
      userName: "Jira",
      subtitle: "Jira Work Panel",
      profileImageId: "j",
      jiraBaseUrl: configBaseUrl || "https://jira.gmarket.com",
      syncMinutes: 3,
      autoSyncEnabled: true,
      ...saved,
      jql: saved.jql || DEFAULT_JQL,
    };
  }

  async saveSettings(payload) {
    const current = this.getSettings();
    const incoming = payload.settings || {};

    // 🔴 보안: 화이트리스트 방식으로 설정 저장
    const settings = {
      ...current,
    };

    // 각 필드를 검증하여 저장
    if (incoming.userName !== undefined) {
      settings.userName = String(incoming.userName).slice(0, 50);
    }
    if (incoming.subtitle !== undefined) {
      settings.subtitle = String(incoming.subtitle).slice(0, 100);
    }
    if (incoming.profileImageId !== undefined) {
      settings.profileImageId = String(incoming.profileImageId).slice(0, 50);
    }
    if (incoming.jiraBaseUrl !== undefined) {
      try {
        settings.jiraBaseUrl = validateUrl(incoming.jiraBaseUrl);
      } catch (error) {
        vscode.window.showWarningMessage(`URL 검증 실패: ${error.message}`);
      }
    }
    if (incoming.syncMinutes !== undefined) {
      const minutes = Number(incoming.syncMinutes);
      settings.syncMinutes = Math.max(0, Math.min(60, minutes));
    }
    if (incoming.autoSyncEnabled !== undefined) {
      settings.autoSyncEnabled = Boolean(incoming.autoSyncEnabled);
    }
    if (incoming.jql !== undefined) {
      try {
        settings.jql = validateJql(incoming.jql);
      } catch (error) {
        vscode.window.showWarningMessage(`JQL 검증 실패: ${error.message}`);
      }
    }

    await this.context.globalState.update(SETTINGS_KEY, settings);

    if (payload.jiraTokenUpdated && payload.jiraToken) {
      await this.context.secrets.store(SECRET_TOKEN_KEY, payload.jiraToken);
    }
  }

  getProfileImages() {
    const webview = this.view?.webview;
    const ids = ["j", "quokka", "pixel", "moon", "star"];

    return ids.map((id) => {
      const label = id === "quokka" ? "Q" : id[0].toUpperCase();
      const src = webview
        ? String(
            webview.asWebviewUri(
              vscode.Uri.joinPath(
                this.context.extensionUri,
                "media",
                "profiles",
                `${id}.png`,
              ),
            ),
          )
        : "";

      return { id, label, src };
    });
  }

  async getState() {
    const settings = this.getSettings();
    const issues = this.context.workspaceState.get(
      "jiraWorkPanel.lastIssues",
      [],
    );
    const hasToken = Boolean(await this.context.secrets.get(SECRET_TOKEN_KEY));
    const currentBranch = await this.getCurrentBranch();
    const branches = await this.getRecentBranches();
    const hasDirtyChanges = await this.hasDirtyChanges();

    return {
      settings,
      profileImages: this.getProfileImages(),
      hasToken,
      issues,
      branchName: currentBranch,
      branches,
      hasDirtyChanges,
      lastSyncedAt: this.context.workspaceState.get(
        "jiraWorkPanel.lastSyncedAt",
        Date.now(),
      ),
    };
  }

  async sendState() {
    if (!this.view) return;
    this.view.webview.postMessage({
      type: "state",
      payload: await this.getState(),
    });
  }

  async syncIssues({ silent = false } = {}) {
    if (!this.view) return;

    try {
      const settings = this.getSettings();
      const token = await this.context.secrets.get(SECRET_TOKEN_KEY);
      let issues = [];

      if (token && settings.jiraBaseUrl) {
        issues = await this.fetchJiraIssues(settings, token);
      } else {
        issues = [];
      }

      const issueMeta = this.context.workspaceState.get(ISSUE_META_KEY, {});
      issues = issues.map((issue) => ({
        ...issue,
        pinned: Boolean(issueMeta[issue.key]?.pinned),
        memo: issueMeta[issue.key]?.memo || "",
      }));

      const lastSyncedAt = Date.now();
      await this.context.workspaceState.update(
        "jiraWorkPanel.lastIssues",
        issues,
      );
      await this.context.workspaceState.update(
        "jiraWorkPanel.lastSyncedAt",
        lastSyncedAt,
      );

      this.view.webview.postMessage({
        type: "issues",
        payload: {
          issues,
          hasToken: Boolean(token),
          lastSyncedAt,
          branchName: await this.getCurrentBranch(),
          branches: await this.getRecentBranches(),
          hasDirtyChanges: await this.hasDirtyChanges(),
        },
      });
    } catch (error) {
      this.view.webview.postMessage({
        type: "syncError",
        payload: { message: error.message || "Jira 동기화 실패" },
      });
      if (!silent) {
        vscode.window.showWarningMessage(`Jira Work Panel: ${error.message}`);
      }
    }
  }

  async fetchJiraIssues(settings, token) {
    const baseUrl = trimTrailingSlash(settings.jiraBaseUrl);
    const jql = settings.jql;

    const fields = "summary,status,assignee,reporter,updated";
    const issues = await fetchAllJiraIssues({
      baseUrl,
      token,
      jql,
      fields,
      maxResults: 100,
      concurrency: 3,
    });

    return issues.map((issue) => {
      const statusCategoryKey = issue.fields?.status?.statusCategory?.key;
      const statusCategory = normalizeStatusCategory(statusCategoryKey);

      return {
        key: issue.key,
        title: issue.fields?.summary || issue.key,
        statusCategory,
        assignee: issue.fields?.assignee?.displayName || "Unassigned",
        reporter: issue.fields?.reporter?.displayName || "",
        updated: formatDate(issue.fields?.updated),
        url: `${baseUrl}/browse/${issue.key}`,
        pinned: false,
        memo: "",
      };
    });
  }

  async saveIssueMeta(payload) {
    const meta = this.context.workspaceState.get(ISSUE_META_KEY, {});
    meta[payload.key] = {
      pinned: Boolean(payload.pinned),
      memo: payload.memo || "",
    };
    await this.context.workspaceState.update(ISSUE_META_KEY, meta);
  }

  async saveBranchAlias(payload) {
    const aliases = this.context.workspaceState.get(BRANCH_ALIAS_KEY, {});
    aliases[payload.branchName] = payload.alias;
    await this.context.workspaceState.update(BRANCH_ALIAS_KEY, aliases);
  }

  async openJira(key) {
    try {
      // 🔴 보안: Jira 키 검증
      const validatedKey = validateJiraKey(key);
      const baseUrl = this.getSettings().jiraBaseUrl;

      // 🔴 보안: URL 검증
      const validatedUrl = validateUrl(baseUrl);

      const finalUrl = `${trimTrailingSlash(validatedUrl)}/browse/${validatedKey}`;
      vscode.env.openExternal(vscode.Uri.parse(finalUrl));
    } catch (error) {
      vscode.window.showErrorMessage(`URL 열기 실패: ${error.message}`);
    }
  }

  async testJiraConnection() {
    try {
      const token = await this.context.secrets.get(SECRET_TOKEN_KEY);
      const settings = this.getSettings();
      if (!token) throw new Error("저장된 토큰이 없습니다.");

      const url = new URL(
        "/rest/api/2/myself",
        trimTrailingSlash(settings.jiraBaseUrl),
      );
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });

      if (!res.ok) throw new Error(`Jira API ${res.status}`);
      this.view?.webview.postMessage({
        type: "connectionResult",
        payload: { ok: true },
      });
    } catch (error) {
      this.view?.webview.postMessage({
        type: "connectionResult",
        payload: { ok: false, message: error.message },
      });
    }
  }

  startAutoSync() {
    clearInterval(this.timer);
    const settings = this.getSettings();
    const minutes = Number(settings.syncMinutes);

    if (!settings.autoSyncEnabled || minutes <= 0) return;

    this.timer = setInterval(
      () => {
        this.syncIssues({ silent: true });
      },
      minutes * 60 * 1000,
    );
  }

  async checkoutBranch(payload) {
    const { branchName, mode } = payload || {};
    if (!branchName) return;

    try {
      // 🔴 보안: 브랜치명 검증
      const validatedBranch = validateBranchName(branchName);
      let stashRef = "";

      if (mode === "stash") {
        await execGit([
          "stash",
          "push",
          "-u",
          "-m",
          `jira-work-panel auto stash ${new Date().toISOString()}`,
        ]);
        stashRef = "stash@{0}";
      }

      if (mode === "discard") {
        await execGit(["reset", "--hard"]);
        await execGit(["clean", "-fd"]);
      }

      await execGit(["checkout", validatedBranch]);

      if (stashRef) {
        await execGit(["stash", "pop", stashRef]);
      }

      // 🎯 개선: 즉시 성공 응답 전송 (상태는 watchGitHead가 자동으로 갱신)
      this.view?.webview.postMessage({
        type: "checkoutResult",
        payload: {
          ok: true,
          branchName: validatedBranch, // 체크아웃한 브랜치명 바로 사용
        },
      });

      // watchGitHead가 .git/HEAD 변경을 감지하고 sendState()를 자동 호출하므로
      // 여기서는 git 명령 실행 불필요
    } catch (error) {
      this.view?.webview.postMessage({
        type: "checkoutResult",
        payload: { ok: false, branchName, message: error.message },
      });
      vscode.window.showWarningMessage(`브랜치 이동 실패: ${error.message}`);
    }
  }
  watchGitHead() {
    if (this.gitHeadWatcher) return;

    this.gitHeadWatcher =
      vscode.workspace.createFileSystemWatcher("**/.git/HEAD");

    const refreshBranchState = () => {
      this.sendState();
    };

    this.gitHeadWatcher.onDidChange(refreshBranchState);
    this.gitHeadWatcher.onDidCreate(refreshBranchState);
    this.gitHeadWatcher.onDidDelete(refreshBranchState);

    this.context.subscriptions.push(this.gitHeadWatcher);
  }
  async getCurrentBranch() {
    try {
      return (await execGit(["branch", "--show-current"])).trim();
    } catch {
      return "";
    }
  }

  async getRecentBranches() {
    try {
      const output = await execGit([
        "for-each-ref",
        "--sort=-committerdate",
        "--count=5",
        "--format=%(refname:short)",
        "refs/heads",
      ]);
      const aliases = this.context.workspaceState.get(BRANCH_ALIAS_KEY, {});
      const current = await this.getCurrentBranch();

      return output
        .split(/\r?\n/)
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => ({
          name,
          alias: aliases[name] || getAutoBranchAlias(name),
          current: name === current,
        }));
    } catch {
      return [];
    }
  }

  async hasDirtyChanges() {
    try {
      return (await execGit(["status", "--porcelain"])).trim().length > 0;
    } catch {
      return false;
    }
  }
}

function execGit(args) {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) {
    return Promise.reject(new Error("열려 있는 워크스페이스가 없습니다."));
  }

  return new Promise((resolve, reject) => {
    cp.execFile("git", args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

function normalizeStatusCategory(categoryKey) {
  if (categoryKey === "new") return "todo";
  if (categoryKey === "indeterminate") return "doing";
  if (categoryKey === "done") return "done";
  return "todo";
}

function getAutoBranchAlias(branchName) {
  const key = String(branchName || "").match(/[A-Z]+-\d+/)?.[0] || "";
  const normalized = String(branchName || "")
    .replace("feature/", "")
    .replace("hotfix/", "")
    .replace("release/", "")
    .replace("bugfix/", "")
    .replace(key, "")
    .replaceAll("/", " ")
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .trim();

  return (
    normalized.split(" ").filter(Boolean).slice(0, 2).join(" ") ||
    key ||
    "branch"
  );
}

async function fetchAllJiraIssues({
  baseUrl,
  token,
  jql,
  fields,
  maxResults = 100,
  concurrency = 3,
}) {
  const firstPage = await fetchJiraSearchPage({
    baseUrl,
    token,
    jql,
    fields,
    startAt: 0,
    maxResults,
  });

  const issues = [...(firstPage.issues || [])];
  const total = Number(firstPage.total || issues.length);

  if (issues.length >= total) {
    return issues;
  }

  const starts = [];

  for (let startAt = maxResults; startAt < total; startAt += maxResults) {
    starts.push(startAt);
  }

  const limit = pLimit(concurrency);
  const pages = await Promise.all(
    starts.map((startAt) =>
      limit(() =>
        fetchJiraSearchPage({
          baseUrl,
          token,
          jql,
          fields,
          startAt,
          maxResults,
        }),
      ),
    ),
  );

  return issues.concat(...pages.map((page) => page.issues || []));
}

async function fetchJiraSearchPage({
  baseUrl,
  token,
  jql,
  fields,
  startAt,
  maxResults,
}) {
  const url = new URL("/rest/api/2/search", baseUrl);

  url.searchParams.set("jql", jql);
  url.searchParams.set("fields", fields);
  url.searchParams.set("startAt", String(startAt));
  url.searchParams.set("maxResults", String(maxResults));

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`Jira API ${res.status}: ${await res.text()}`);
  }

  return res.json();
}

function pLimit(concurrency = 3) {
  const queue = [];
  let activeCount = 0;

  const next = () => {
    activeCount -= 1;

    if (queue.length > 0) {
      queue.shift()();
    }
  };

  return (fn) =>
    new Promise((resolve, reject) => {
      const run = () => {
        activeCount += 1;

        Promise.resolve().then(fn).then(resolve, reject).finally(next);
      };

      if (activeCount < concurrency) {
        run();
      } else {
        queue.push(run);
      }
    });
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${month}.${day}`;
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function getNonce() {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

function deactivate() {}

module.exports = { activate, deactivate };
