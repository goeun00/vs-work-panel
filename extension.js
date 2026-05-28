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

const ISSUE_FIELD_NAMES = {
  epicLink: "Epic Link",
};

let cachedIssueFieldIds = null;

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
    this.gitHeadRefreshTimer = null;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    this.watchGitHead();

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.scheduleBranchStateRefresh(0);
      }
    });

    webviewView.webview.options = {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ],
    };
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
        "openExternal",
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

      if (type === "openExternal") {
        await this.openExternal(payload.url);
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
    const [hasToken, currentBranch] = await Promise.all([
      this.context.secrets.get(SECRET_TOKEN_KEY).then(Boolean),
      this.getCurrentBranch(),
    ]);
    const [branches, hasDirtyChanges] = await Promise.all([
      this.getRecentBranches(currentBranch),
      this.hasDirtyChanges(),
    ]);

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

  async sendBranchState() {
    if (!this.view) return;

    const branchName = await this.getCurrentBranch();
    const [branches, hasDirtyChanges] = await Promise.all([
      this.getRecentBranches(branchName),
      this.hasDirtyChanges(),
    ]);

    this.view.webview.postMessage({
      type: "branchState",
      payload: {
        branchName,
        branches,
        hasDirtyChanges,
      },
    });
  }

  scheduleBranchStateRefresh(delay = 120) {
    clearTimeout(this.gitHeadRefreshTimer);

    this.gitHeadRefreshTimer = setTimeout(() => {
      this.sendBranchState();
    }, delay);
  }

  watchGitHead() {
    if (this.gitHeadWatcher) return;

    this.gitHeadWatcher =
      vscode.workspace.createFileSystemWatcher("**/.git/HEAD");

    const refreshBranchState = () => {
      this.scheduleBranchStateRefresh(120);
    };

    this.gitHeadWatcher.onDidChange(refreshBranchState);
    this.gitHeadWatcher.onDidCreate(refreshBranchState);
    this.gitHeadWatcher.onDidDelete(refreshBranchState);

    this.context.subscriptions.push(this.gitHeadWatcher);
  }

  postBranchProgress(message, percent = null) {
    this.view?.webview.postMessage({
      type: "branchProgress",
      payload: {
        message,
        percent,
      },
    });
  }

  createBranchProgressReporter(baseMessage) {
    let lastSentAt = 0;
    let lastPercent = -1;

    return ({ percent }) => {
      if (!Number.isFinite(percent)) return;

      const now = Date.now();
      const shouldSend =
        percent !== lastPercent && (now - lastSentAt > 80 || percent === 100);

      if (!shouldSend) return;

      lastSentAt = now;
      lastPercent = percent;
      this.postBranchProgress(`${baseMessage} ${percent}%`, percent);
    };
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

      const currentBranch = await this.getCurrentBranch();
      const [branches, hasDirtyChanges] = await Promise.all([
        this.getRecentBranches(currentBranch),
        this.hasDirtyChanges(),
      ]);

      this.view.webview.postMessage({
        type: "issues",
        payload: {
          issues,
          hasToken: Boolean(token),
          lastSyncedAt,
          branchName: currentBranch,
          branches,
          hasDirtyChanges,
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

    const issueFieldIds = await getIssueFieldIds(baseUrl, token);
    const epicLinkField = issueFieldIds.epicLink;

    const fields = ["summary,status,assignee,reporter,updated", epicLinkField]
      .filter(Boolean)
      .join(",");

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
      const epicKey = epicLinkField ? issue.fields?.[epicLinkField] || "" : "";

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
        epicKey,
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

  async openExternal(url) {
    try {
      const validatedUrl = validateUrl(url);
      vscode.env.openExternal(vscode.Uri.parse(validatedUrl));
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
    const { branchName, mode = "normal" } = payload || {};
    if (!branchName) return;

    let validatedBranch = "";

    try {
      // 🔴 보안: 브랜치명 검증
      validatedBranch = validateBranchName(branchName);

      let stashCreated = false;

      if (mode === "stash") {
        const stashOutput = await execGit([
          "stash",
          "push",
          "-u",
          "-m",
          `jira-work-panel auto stash ${new Date().toISOString()}`,
        ]);

        stashCreated = !/No local changes to save/i.test(stashOutput);
      }

      if (mode === "discard") {
        this.postBranchProgress("변경사항 정리 중");
        await execGit(["reset", "--hard"]);
        await execGit(["clean", "-fd"]);
      }

      const reportCheckoutProgress =
        this.createBranchProgressReporter("브랜치 전환 중");

      this.postBranchProgress("브랜치 전환 중");
      await execGitWithProgress(
        ["checkout", "--progress", validatedBranch],
        reportCheckoutProgress,
      );

      if (mode === "stash" && stashCreated) {
        this.postBranchProgress("stash 복원 중");
        await execGit(["stash", "pop", "stash@{0}"]);
      }

      this.view?.webview.postMessage({
        type: "checkoutResult",
        payload: {
          ok: true,
          branchName: validatedBranch,
          // 빠른 응답용 힌트입니다. 정확한 dirty/branches 상태는 branchState에서 다시 내려줍니다.
          hasDirtyChanges:
            mode === "discard" ? false : mode === "stash" && stashCreated,
        },
      });

      this.scheduleBranchStateRefresh(0);
    } catch (error) {
      let currentBranch = validatedBranch || branchName;

      try {
        currentBranch = await this.getCurrentBranch();
      } catch {
        // 실패 상황에서는 추가 조회 실패를 무시합니다.
      }

      this.view?.webview.postMessage({
        type: "checkoutResult",
        payload: {
          ok: false,
          branchName: currentBranch || branchName,
          message: error.message,
        },
      });

      this.scheduleBranchStateRefresh(0);
      vscode.window.showWarningMessage(`브랜치 이동 실패: ${error.message}`);
    }
  }

  async getCurrentBranch() {
    try {
      return (await execGit(["branch", "--show-current"])).trim();
    } catch {
      return "";
    }
  }

  async getRecentBranches(current = "") {
    try {
      const output = await execGit([
        "for-each-ref",
        "--sort=-committerdate",
        "--count=8",
        "--format=%(refname:short)",
        "refs/heads",
      ]);
      const aliases = this.context.workspaceState.get(BRANCH_ALIAS_KEY, {});

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

function execGitWithProgress(args, onProgress) {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) {
    return Promise.reject(new Error("열려 있는 워크스페이스가 없습니다."));
  }

  return new Promise((resolve, reject) => {
    const child = cp.spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";

    const handleChunk = (chunk, streamName) => {
      const text = chunk.toString();

      if (streamName === "stdout") {
        stdout += text;
      } else {
        stderr += text;
      }

      const progress = parseGitProgress(text);
      if (progress) {
        onProgress?.(progress);
      }
    };

    child.stdout.on("data", (chunk) => handleChunk(chunk, "stdout"));
    child.stderr.on("data", (chunk) => handleChunk(chunk, "stderr"));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout || stderr);
        return;
      }

      reject(new Error(stderr || `git exited with code ${code}`));
    });
  });
}

function parseGitProgress(text) {
  const lines = String(text || "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const message = lines.at(-1) || String(text || "").trim();
  const match = message.match(/(\d{1,3})%/);

  if (!match) return null;

  return {
    percent: Math.max(0, Math.min(100, Number(match[1]))),
    message,
  };
}

function normalizeStatusCategory(categoryKey) {
  if (categoryKey === "new") return "todo";
  if (categoryKey === "indeterminate") return "doing";
  if (categoryKey === "done") return "done";
  return "todo";
}

function normalizeFieldName(name = "") {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function findFieldIdByNames(fields = [], names = []) {
  const normalizedNames = names.map(normalizeFieldName);

  const matched = fields.find((field) =>
    normalizedNames.includes(normalizeFieldName(field.name)),
  );

  return matched?.id || "";
}

async function getIssueFieldIds(baseUrl, token) {
  if (cachedIssueFieldIds) return cachedIssueFieldIds;

  const url = new URL("/rest/api/2/field", trimTrailingSlash(baseUrl));

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      cachedIssueFieldIds = { epicLink: "" };
      return cachedIssueFieldIds;
    }

    const fields = await res.json();

    cachedIssueFieldIds = {
      epicLink: findFieldIdByNames(fields, [ISSUE_FIELD_NAMES.epicLink]),
    };

    return cachedIssueFieldIds;
  } catch {
    cachedIssueFieldIds = { epicLink: "" };
    return cachedIssueFieldIds;
  }
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
