const vscode = acquireVsCodeApi();

const state = {
  view: "list",
  filter: "pin",
  keyword: "",
  ready: false,
  loading: {
    jira: false,
    branch: false,
  },
  profileDraftImageId: "",
  profileDropdownOpen: false,
  branchExpanded: false,
  editingAliasBranch: "",
  openMemoKey: "",
  editingMemoKey: "",
  pendingCheckoutBranch: "",
  checkoutError: "",
  hasDirtyChanges: false,
  hasToken: false,
  lastSyncedAt: Date.now(),
  branchName: "",
  branches: [],
  profileImages: [],
  settings: {
    userName: "Jira",
    subtitle: "Jira Work Panel",
    profileImageId: "j",
    jiraBaseUrl: "",
    syncMinutes: 3,
    autoSyncEnabled: true,
    jql: "",
  },
  issues: [],
};

const els = {
  panelHeader: document.querySelector("#panelHeader"),
  listView: document.querySelector("#listView"),
  settingsView: document.querySelector("#settingsView"),
  panelIcon: document.querySelector("#panelIcon"),
  panelUserName: document.querySelector("#panelUserName"),
  panelMoodText: document.querySelector("#panelMoodText"),
  viewToggleButton: document.querySelector("#viewToggleButton"),
  autoSyncButton: document.querySelector("#autoSyncButton"),
  syncStatusDot: document.querySelector("#syncStatusDot"),
  syncIntervalText: document.querySelector("#syncIntervalText"),
  lastSyncedText: document.querySelector("#lastSyncedText"),
  branchName: document.querySelector("#branchName"),
  dirtyDot: document.querySelector("#dirtyDot"),
  branchList: document.querySelector("#branchList"),
  branchMoreButton: document.querySelector("#branchMoreButton"),
  searchInput: document.querySelector("#searchInput"),
  tabs: [...document.querySelectorAll(".jira-panel__tab")],
  searchFilterNote: document.querySelector("#searchFilterNote"),
  counts: [...document.querySelectorAll("[data-count]")],
  list: document.querySelector("#jiraList"),
  settingUserName: document.querySelector("#settingUserName"),
  settingSubtitle: document.querySelector("#settingSubtitle"),
  settingIconPreview: document.querySelector("#settingIconPreview"),
  settingProfileTrigger: document.querySelector("#settingProfileTrigger"),
  settingProfileText: document.querySelector("#settingProfileText"),
  settingProfileList: document.querySelector("#settingProfileList"),
  settingJiraBaseUrl: document.querySelector("#settingJiraBaseUrl"),
  settingJiraToken: document.querySelector("#settingJiraToken"),
  settingTokenStatus: document.querySelector("#settingTokenStatus"),
  settingSyncMinutes: document.querySelector("#settingSyncMinutes"),
  settingJql: document.querySelector("#settingJql"),
  checkoutGuard: document.querySelector("#checkoutGuard"),
  checkoutGuardBranch: document.querySelector("#checkoutGuardBranch"),
  checkoutGuardDesc: document.querySelector("#checkoutGuardDesc"),
  directCheckoutButton: document.querySelector("#directCheckoutButton"),
  toast: document.querySelector("#toast"),
};

function mergeState(payload) {
  const currentLoading = { ...state.loading };

  Object.assign(state, payload || {});
  state.settings = {
    ...state.settings,
    ...(payload?.settings || {}),
  };
  state.loading = {
    ...currentLoading,
    ...(payload?.loading || {}),
  };
}

function setLoading(type, value) {
  state.loading = {
    ...state.loading,
    [type]: value,
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function escapeRegExp(value) {
  const specialChars = new Set([
    ".",
    "+",
    "*",
    "?",
    "^",
    "$",
    "{",
    "}",
    "(",
    ")",
    "|",
    "[",
    "]",
  ]);
  const backslash = String.fromCharCode(92);
  specialChars.add(backslash);

  return String(value)
    .split("")
    .map((char) => (specialChars.has(char) ? backslash + char : char))
    .join("");
}

function getSearchKeyword() {
  return state.keyword.trim();
}

function highlightText(value, keyword = getSearchKeyword()) {
  const text = escapeHtml(value);
  const normalizedKeyword = keyword.trim();

  if (!normalizedKeyword) return text;

  const pattern = new RegExp(`(${escapeRegExp(normalizedKeyword)})`, "gi");
  return text.replace(pattern, '<mark class="jira-highlight">$1</mark>');
}

function getMemoLines(value) {
  return String(value || "").split(String.fromCharCode(10));
}

function trimUrlSuffix(token) {
  const suffixChars = ".,)]}";
  let url = String(token || "");
  let suffix = "";

  while (url && suffixChars.includes(url.at(-1))) {
    suffix = url.at(-1) + suffix;
    url = url.slice(0, -1);
  }

  return { url, suffix };
}

function linkifyMemoText(value) {
  return String(value || "")
    .split(" ")
    .map((token, index) => {
      const prefix = index > 0 ? " " : "";
      const { url, suffix } = trimUrlSuffix(token);
      const isUrl = url.startsWith("https://") || url.startsWith("http://");

      if (!isUrl) return `${prefix}${escapeHtml(token)}`;

      return `${prefix}<a class="jira-card__memo-link" href="${escapeAttr(url)}" data-action="openExternal" data-url="${escapeAttr(url)}">${escapeHtml(url)}</a>${escapeHtml(suffix)}`;
    })
    .join("");
}

function getBranchIssueKey(branchName) {
  return String(branchName || "").match(/[A-Z]+-\d+/)?.[0] || "";
}

function getStatusLabel(statusCategory) {
  return (
    {
      todo: "Todo",
      doing: "Doing",
      done: "Done",
    }[statusCategory] ||
    statusCategory ||
    "Todo"
  );
}

function getSelectedProfileImage(
  profileImageId = state.settings.profileImageId,
) {
  return (
    state.profileImages.find((image) => image.id === profileImageId) ||
    state.profileImages[0] || { label: "J", src: "" }
  );
}

function getDraftProfileImageId() {
  return state.profileDraftImageId || state.settings.profileImageId;
}

function updateIcon(target, image) {
  if (!image?.src) {
    target.textContent = image?.label || "J";
    return;
  }

  target.innerHTML = `<img src="${escapeAttr(image.src)}" alt="" />`;
}

function formatRelativeSyncTime(timestamp) {
  const diff = Date.now() - Number(timestamp || Date.now());
  const minutes = Math.floor(diff / 60000);

  if (minutes <= 0) return "방금 전 동기화";
  if (minutes < 60) return `${minutes}분 전 동기화`;
  return `${Math.floor(minutes / 60)}시간 전 동기화`;
}

function updateHeader() {
  const branchKey = getBranchIssueKey(state.branchName);
  const syncMinutes = Number(state.settings.syncMinutes);
  const autoSyncEnabled =
    Boolean(state.settings.autoSyncEnabled) && syncMinutes > 0;

  els.panelUserName.textContent = state.settings.userName || "Jira";
  els.panelMoodText.textContent = state.settings.subtitle || "Jira Work Panel";
  updateIcon(els.panelIcon, getSelectedProfileImage());

  els.syncIntervalText.textContent = autoSyncEnabled
    ? `Auto ${syncMinutes}m`
    : "Auto off";
  els.syncStatusDot.classList.toggle(
    "jira-panel__sync-dot--off",
    !autoSyncEnabled,
  );
  els.autoSyncButton.setAttribute("aria-pressed", String(autoSyncEnabled));
  if (els.lastSyncedText) {
    els.lastSyncedText.textContent = formatRelativeSyncTime(state.lastSyncedAt);
  }

  const branchBox = els.branchName.closest(".jira-panel__branch");
  branchBox?.classList.toggle(
    "jira-panel__branch--loading",
    state.loading.branch,
  );

  els.branchName.textContent = state.loading.branch
    ? "브랜치 확인 중"
    : state.branchName || "브랜치 없음";
  if (els.dirtyDot) {
    els.dirtyDot.hidden = state.loading.branch || !state.hasDirtyChanges;
  }
  els.branchMoreButton.disabled = state.loading.branch;

  renderBranches();
}

function renderBranches() {
  const branches = state.branches.slice(0, 5);
  const hiddenCount = state.branches.slice(0, 5).length;

  els.branchList.classList.toggle(
    "jira-panel__branch-list--expanded",
    state.branchExpanded,
  );
  els.branchMoreButton.setAttribute(
    "aria-expanded",
    String(state.branchExpanded),
  );
  els.branchMoreButton.innerHTML = state.branchExpanded
    ? '<span>Recent</span><span class="codicon codicon-chevron-up" aria-hidden="true"></span>'
    : '<span>Recent</span><span class="codicon codicon-chevron-down" aria-hidden="true"></span>';
  els.branchMoreButton.title = state.branchExpanded
    ? "최근 브랜치 접기"
    : "최근 브랜치 열기";
  els.branchMoreButton.style.display = hiddenCount ? "inline-flex" : "none";

  els.branchList.innerHTML = branches
    .map((branch) => {
      const key = getBranchIssueKey(branch.name);
      const isCurrent = branch.name === state.branchName;
      const isEditing = branch.name === state.editingAliasBranch;

      if (isEditing) {
        return `
        <span class="jira-panel__branch-alias-form">
          ${key ? `${key ? `<span class="jira-panel__branch-alias-key">${escapeHtml(key)}</span>` : ""}` : ""}
          <input class="jira-panel__branch-alias-input" data-alias-input="${escapeAttr(branch.name)}" type="text" value="${escapeAttr(branch.alias || getAutoBranchAlias(branch.name))}" aria-label="브랜치 애칭" />
          <button class="jira-panel__branch-alias-action" type="button" data-action="saveAliasEdit" title="저장">✓</button>
          <button class="jira-panel__branch-alias-action" type="button" data-action="cancelAliasEdit" title="취소">×</button>
        </span>
      `;
      }

      return `
      <span class="jira-panel__branch-chip-wrap">
        <button class="jira-panel__branch-chip" type="button" data-action="checkoutBranch" data-branch="${escapeAttr(branch.name)}" aria-pressed="${isCurrent}" title="${escapeAttr(branch.name)} 브랜치로 이동">
          ${key ? `${key ? `<span class="jira-panel__branch-chip-key">${escapeHtml(key)}</span>` : ""}` : ""}
          <span class="jira-panel__branch-chip-name">${escapeHtml(branch.alias || getAutoBranchAlias(branch.name))}</span>
        </button>
        <button class="jira-panel__branch-edit" type="button" data-action="editBranchAlias" data-branch="${escapeAttr(branch.name)}" title="애칭 수정" aria-label="${escapeAttr(branch.name)} 애칭 수정">✎</button>
      </span>
    `;
    })
    .join("");
}

function getAutoBranchAlias(branchName) {
  const key = getBranchIssueKey(branchName);
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

function updateSettingsForm() {
  els.settingUserName.value = state.settings.userName || "";
  els.settingSubtitle.value = state.settings.subtitle || "";
  els.settingJiraBaseUrl.value = state.settings.jiraBaseUrl || "";
  els.settingSyncMinutes.value = String(state.settings.syncMinutes ?? 3);
  els.settingJql.value = state.settings.jql || "";
  els.settingTokenStatus.textContent = state.hasToken
    ? "✓ 토큰이 VS Code SecretStorage에 저장되어 있습니다."
    : "토큰이 아직 저장되지 않았습니다. PAT를 입력하고 저장해 주세요.";
  updateIcon(
    els.settingIconPreview,
    getSelectedProfileImage(getDraftProfileImageId()),
  );
  renderProfileImages();
}

function renderProfileImages() {
  const draftProfileImageId = getDraftProfileImageId();
  const selectedImage = getSelectedProfileImage(draftProfileImageId);
  els.settingProfileList.classList.toggle(
    "setting-profile-list--open",
    state.profileDropdownOpen,
  );
  els.settingProfileTrigger.setAttribute(
    "aria-expanded",
    String(state.profileDropdownOpen),
  );
  if (els.settingProfileText) {
    els.settingProfileText.textContent = selectedImage.id;
  }

  els.settingProfileList.innerHTML = state.profileImages
    .map((image) => {
      const selected = image.id === draftProfileImageId;
      const content = image.src
        ? `<img src="${escapeAttr(image.src)}" alt="" />`
        : escapeHtml(image.label);

      return `
      <button class="setting-profile-button" type="button" data-action="selectProfileImage" data-profile-id="${escapeAttr(image.id)}" aria-pressed="${selected}" title="${escapeAttr(image.id)}">
        ${content}
      </button>
    `;
    })
    .join("");
}

function updateView() {
  const isSettings = state.view === "settings";
  els.listView.classList.toggle("jira-panel__view--active", !isSettings);
  els.settingsView.classList.toggle("jira-panel__view--active", isSettings);
  els.panelHeader.classList.toggle("jira-panel__header--settings", isSettings);
  els.viewToggleButton.innerHTML = isSettings
    ? '<span class="codicon codicon-arrow-left" aria-hidden="true"></span>'
    : '<span class="codicon codicon-settings-gear" aria-hidden="true"></span>';
  els.viewToggleButton.title = isSettings ? "목록으로 돌아가기" : "설정";
}

function updateCounts() {
  const counts = state.issues.reduce(
    (acc, issue) => {
      if (issue.pinned) acc.pin += 1;
      acc[issue.statusCategory] = (acc[issue.statusCategory] || 0) + 1;
      return acc;
    },
    { pin: 0, todo: 0, doing: 0, done: 0 },
  );

  els.counts.forEach((count) => {
    count.textContent = counts[count.dataset.count] || 0;
  });
}

function getVisibleIssues() {
  const keyword = getSearchKeyword();
  const branchKey = getBranchIssueKey(state.branchName);

  return state.issues
    .filter((issue) => {
      if (keyword) return true;
      return state.filter === "pin"
        ? issue.pinned
        : issue.statusCategory === state.filter;
    })
    .filter((issue) => {
      if (!keyword) return true;
      return [
        issue.key,
        issue.title,
        issue.memo,
        issue.assignee,
        issue.reporter,
        issue.statusCategory,
      ]
        .join(" ")
        .toLowerCase()
        .includes(keyword.toLowerCase());
    })
    .sort((a, b) => {
      if (a.key === branchKey) return -1;
      if (b.key === branchKey) return 1;
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return 0;
    });
}

function renderIssues() {
  const issues = getVisibleIssues();
  const branchKey = getBranchIssueKey(state.branchName);

  if (!state.ready || state.loading.jira) {
    els.list.innerHTML = getLoadingTemplate();
    return;
  }

  if (!issues.length) {
    els.list.innerHTML = getEmptyTemplate();
    return;
  }

  els.list.innerHTML = issues
    .map((issue) => {
      const hasMemo = String(issue.memo || "").trim().length > 0;
      const memoLines = getMemoLines(issue.memo);
      const hasMultiLineMemo = memoLines.length > 1;
      const hiddenMemoLineCount = Math.max(memoLines.length - 1, 0);
      const isMemoOpen = state.openMemoKey === issue.key;
      const isMemoEditing = state.editingMemoKey === issue.key;
      const isActiveBranch = issue.key === branchKey;
      const classes = [
        "jira-card",
        isActiveBranch ? "jira-card--active" : "",
        isMemoOpen ? "jira-card--memo-open" : "",
        isMemoEditing ? "jira-card--memo-editing" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const memoView = memoLines
        .map((line) => `<p>${line ? linkifyMemoText(line) : "&nbsp;"}</p>`)
        .join("");

      return `
      <article class="${classes}" data-key="${escapeAttr(issue.key)}">
        <div class="jira-card__inner">
          <div class="jira-card__top">
            <div class="jira-card__main">
              <div class="jira-card__key-row">
                <a class="jira-card__key" href="${escapeAttr(issue.url)}" data-action="open" data-key="${escapeAttr(issue.key)}">${highlightText(issue.key)}</a>
                <span class="jira-card__tag jira-card__tag--${escapeAttr(issue.statusCategory)}">${escapeHtml(getStatusLabel(issue.statusCategory))}</span>
                ${isActiveBranch ? '<span class="jira-card__tag">current</span>' : ""}
              </div>
              <p class="jira-card__title">${highlightText(issue.title)}</p>
            </div>
            <div class="jira-card__actions">
              <button class="jira-card__action" type="button" data-action="pin" data-key="${escapeAttr(issue.key)}" aria-pressed="${issue.pinned}" title="자주 보는 Jira 고정"><span class="codicon ${issue.pinned ? "codicon-star-full" : "codicon-star-empty"}" aria-hidden="true"></span></button>
            </div>
          </div>
          <div class="jira-card__meta">
            <span>${highlightText(issue.reporter ? `요청자 ${issue.reporter}` : issue.assignee || "")}</span>
            <span>·</span>
            <span>${escapeHtml(issue.updated || "")}</span>
          </div>
          <div class="jira-card__memo-bar ${hasMemo ? "" : "jira-card__memo-bar--empty"} ${isMemoEditing ? "jira-card__memo-bar--editing" : ""}">
            <button class="jira-card__memo-summary ${hasMemo ? "" : "jira-card__memo-summary--empty"}" type="button" data-action="memo" data-key="${escapeAttr(issue.key)}" aria-disabled="${isMemoEditing}">
              ${
                hasMemo
                  ? `
                <span class="jira-card__memo-summary-label">memo</span>
                <span class="jira-card__memo-summary-text">${highlightText(memoLines[0] || "")}</span>
                ${hasMultiLineMemo ? `<span class="jira-card__memo-line-hint" title="${memoLines.length}줄 메모">+${hiddenMemoLineCount}</span>` : ""}
                <span class="jira-card__memo-toggle codicon ${isMemoOpen ? "codicon-chevron-up" : "codicon-chevron-down"}" aria-hidden="true"></span>
              `
                  : '<span class="jira-card__memo-add">+ memo</span>'
              }
            </button>
            ${hasMemo ? `<button class="jira-card__memo-edit" type="button" data-action="memoEdit" data-key="${escapeAttr(issue.key)}" title="메모 수정" aria-label="${escapeAttr(issue.key)} 메모 수정"><span class="codicon codicon-edit" aria-hidden="true"></span></button>` : ""}
          </div>
          <div class="jira-card__memo">
            ${
              isMemoEditing
                ? `
              <textarea class="jira-panel__textarea" data-memo-key="${escapeAttr(issue.key)}" placeholder="이 Jira에만 남길 간단한 메모">${escapeHtml(issue.memo || "")}</textarea>
              <div class="jira-card__memo-tools">
                <button class="jira-panel__button" type="button" data-action="memoCancel" data-key="${escapeAttr(issue.key)}">취소</button>
                <button class="jira-panel__button jira-panel__button--primary" type="button" data-action="memoSave" data-key="${escapeAttr(issue.key)}">저장</button>
              </div>
            `
                : `<div class="jira-card__memo-view">${memoView}</div>`
            }
          </div>
        </div>
      </article>
    `;
    })
    .join("");
}

function getEmptyTemplate() {
  if (!state.hasToken) {
    return `
      <div class="jira-empty">
        <strong class="jira-empty__title">Jira 연결이 필요합니다.</strong>
        <p class="jira-empty__desc">설정에서 Jira Base URL과 PAT를 저장해 주세요.</p>
      </div>
    `;
  }

  if (state.filter === "pin" && !state.keyword.trim()) {
    return `
      <div class="jira-empty">
        <strong class="jira-empty__title">고정된 Jira가 없습니다.</strong>
        <p class="jira-empty__desc">자주 확인하는 이슈는 ☆를 눌러 고정할 수 있습니다.</p>
      </div>
    `;
  }

  return `
    <div class="jira-empty">
      <strong class="jira-empty__title">일치하는 Jira가 없습니다.</strong>
      <p class="jira-empty__desc">검색어 또는 필터를 조정해 주세요.</p>
    </div>
  `;
}

function getLoadingTemplate() {
  return `
    <div class="jira-loading-bar" aria-hidden="true"></div>
    <div class="jira-skeleton" aria-label="Jira 목록 불러오는 중">
      ${[1, 2, 3]
        .map(
          () => `
        <div class="jira-skeleton__card">
          <div class="jira-skeleton__line jira-skeleton__line--short"></div>
          <div class="jira-skeleton__line"></div>
          <div class="jira-skeleton__line jira-skeleton__line--mid"></div>
        </div>
      `,
        )
        .join("")}
    </div>
  `;
}

function render() {
  updateHeader();
  updateSettingsForm();
  updateView();
  updateCounts();

  els.searchInput.value = state.keyword;

  const isSearching = Boolean(getSearchKeyword());
  els.tabs.forEach((tab) => {
    tab.setAttribute(
      "aria-selected",
      String(!isSearching && tab.dataset.filter === state.filter),
    );
    tab.disabled = isSearching;
    tab.setAttribute("aria-disabled", String(isSearching));
  });
  if (els.searchFilterNote) {
    els.searchFilterNote.hidden = !isSearching;
  }

  renderIssues();
  persistViewState();
}

function post(type, payload = {}) {
  vscode.postMessage({ type, payload });
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("jira-toast--show");

  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    els.toast.classList.remove("jira-toast--show");
  }, 1500);
}

function persistViewState() {
  const persisted = {
    ...state,
    loading: {
      ...state.loading,
      jira: false,
      branch: false,
    },
    profileDropdownOpen: false,
    editingAliasBranch: "",
    pendingCheckoutBranch: "",
    checkoutError: "",
  };

  vscode.setState(persisted);
}

function hydrateViewState() {
  const persisted = vscode.getState?.();
  if (!persisted) return;

  mergeState({
    ...persisted,
    ready: true,
    loading: {
      ...state.loading,
      ...(persisted.loading || {}),
      jira: false,
      branch: false,
    },
  });
}

function toggleProfileDropdown() {
  syncSettingsFromForm();
  state.profileDropdownOpen = !state.profileDropdownOpen;
  render();
}
function syncSettingsFromForm() {
  state.settings.userName = els.settingUserName.value.trim() || "Jira";
  state.settings.subtitle =
    els.settingSubtitle.value.trim() || "Jira Work Panel";
  state.settings.jiraBaseUrl = els.settingJiraBaseUrl.value.trim();
  state.settings.syncMinutes = Number(els.settingSyncMinutes.value);
  state.settings.autoSyncEnabled = state.settings.syncMinutes > 0;
  state.settings.jql = els.settingJql.value.trim();
}

function selectProfileImage(profileImageId) {
  syncSettingsFromForm();
  state.profileDraftImageId = profileImageId;
  state.profileDropdownOpen = false;
  render();
}
function saveSettings() {
  const tokenValue = els.settingJiraToken.value.trim();
  const prevJiraBaseUrl = state.settings.jiraBaseUrl || "";
  const prevJql = state.settings.jql || "";

  syncSettingsFromForm();

  state.settings.profileImageId =
    state.profileDraftImageId || state.settings.profileImageId;

  state.profileDraftImageId = "";

  const shouldReloadJira =
    prevJiraBaseUrl !== state.settings.jiraBaseUrl ||
    prevJql !== state.settings.jql ||
    Boolean(tokenValue);

  if (tokenValue) {
    state.hasToken = true;
  }

  post("saveSettings", {
    settings: state.settings,
    jiraTokenUpdated: Boolean(tokenValue),
    jiraToken: tokenValue,
  });

  els.settingJiraToken.value = "";
  state.view = "list";

  if (shouldReloadJira) {
    setLoading("jira", true);
    post("syncIssues");
  }

  showToast("설정 저장 완료");
  render();
}
function toggleAutoSync() {
  const syncMinutes = Number(state.settings.syncMinutes);
  state.settings.autoSyncEnabled = !state.settings.autoSyncEnabled;

  if (state.settings.autoSyncEnabled && syncMinutes <= 0) {
    state.settings.syncMinutes = 3;
  }

  post("saveSettings", { settings: state.settings });
  render();
  showToast(
    state.settings.autoSyncEnabled ? "Auto sync 켜짐" : "Auto sync 꺼짐",
  );
}

function requestSync() {
  setLoading("jira", true);
  render();
  post("syncIssues");
}

function togglePin(key) {
  const issue = state.issues.find((item) => item.key === key);
  if (!issue) return;

  issue.pinned = !issue.pinned;
  post("saveIssueMeta", {
    key,
    pinned: issue.pinned,
    memo: issue.memo || "",
  });
  render();
}

function toggleMemo(key) {
  const issue = state.issues.find((item) => item.key === key);
  if (!issue) return;

  if (state.editingMemoKey === key) return;

  if (!String(issue.memo || "").trim()) {
    editMemo(key);
    return;
  }

  state.openMemoKey =
    state.openMemoKey === key && state.editingMemoKey !== key ? "" : key;
  state.editingMemoKey = "";
  render();
}

function editMemo(key) {
  const issue = state.issues.find((item) => item.key === key);
  if (!issue) return;

  state.openMemoKey = key;
  state.editingMemoKey = key;
  render();

  requestAnimationFrame(() => {
    const textarea = document.querySelector(
      `[data-memo-key="${CSS.escape(key)}"]`,
    );
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  });
}

function cancelMemoEdit(key) {
  state.editingMemoKey = "";
  if (
    !String(state.issues.find((item) => item.key === key)?.memo || "").trim()
  ) {
    state.openMemoKey = "";
  }
  render();
}

function saveMemo(key) {
  const textarea = document.querySelector(
    `[data-memo-key="${CSS.escape(key)}"]`,
  );
  const issue = state.issues.find((item) => item.key === key);
  if (!textarea || !issue) return;

  issue.memo = textarea.value.trim();
  post("saveIssueMeta", {
    key,
    pinned: Boolean(issue.pinned),
    memo: issue.memo,
  });
  state.openMemoKey = issue.memo ? key : "";
  state.editingMemoKey = "";
  render();
  showToast(`${key} 메모 저장 완료`);
}

function toggleBranches() {
  state.branchExpanded = !state.branchExpanded;
  render();
}

function editBranchAlias(branchName) {
  state.editingAliasBranch = branchName;
  render();

  requestAnimationFrame(() => {
    const input = document.querySelector(
      `[data-alias-input="${CSS.escape(branchName)}"]`,
    );
    input?.focus();
    input?.select();
  });
}

function closeAliasEditor() {
  state.editingAliasBranch = "";
  render();
}

function saveBranchAlias() {
  const branchName = state.editingAliasBranch;
  const input = document.querySelector(
    `[data-alias-input="${CSS.escape(branchName)}"]`,
  );
  const alias = input?.value.trim() || "";

  state.branches = state.branches.map((branch) =>
    branch.name === branchName
      ? { ...branch, alias: alias || getAutoBranchAlias(branchName) }
      : branch,
  );
  state.editingAliasBranch = "";

  post("saveBranchAlias", {
    branchName,
    alias: alias || getAutoBranchAlias(branchName),
  });
  render();
}

function checkoutBranch(branchName) {
  if (!branchName || branchName === state.branchName) return;

  if (state.hasDirtyChanges) {
    openCheckoutGuard(branchName);
    return;
  }

  requestCheckout(branchName, "normal");
}

function canDirectCheckout(branchName) {
  const target = state.branches.find((branch) => branch.name === branchName);
  return target?.canDirectCheckout !== false;
}

function openCheckoutGuard(branchName, errorMessage = "") {
  const directAllowed = canDirectCheckout(branchName) && !errorMessage;

  state.pendingCheckoutBranch = branchName;
  state.checkoutError = errorMessage;
  els.checkoutGuardBranch.textContent = branchName;
  if (els.checkoutGuardTitle) {
    els.checkoutGuardTitle.textContent = errorMessage
      ? "그냥 이동할 수 없어요"
      : "변경사항이 있어요";
  }
  if (els.checkoutGuardDesc) {
    els.checkoutGuardDesc.textContent = errorMessage
      ? errorMessage
      : directAllowed
        ? "그대로 이동하거나, 먼저 임시저장할 수 있어요."
        : "이 브랜치는 바로 이동하기 어려워 보여요.";
  }
  if (els.directCheckoutButton) {
    els.directCheckoutButton.hidden = !directAllowed;
  }
  els.checkoutGuard.classList.add("checkout-guard--show");
  els.checkoutGuard.setAttribute("aria-hidden", "false");
}

function closeCheckoutGuard() {
  state.pendingCheckoutBranch = "";
  state.checkoutError = "";
  els.checkoutGuard.classList.remove("checkout-guard--show");
  els.checkoutGuard.setAttribute("aria-hidden", "true");
}

function confirmCheckout(mode) {
  const branchName = state.pendingCheckoutBranch;
  if (!branchName) return;

  closeCheckoutGuard();
  requestCheckout(branchName, mode);
}

function requestCheckout(branchName, mode) {
  setLoading("branch", true);
  render();
  post("checkoutBranch", { branchName, mode });
}

function bindEvents() {
  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;

    const { action, key, branch, mode, profileId } = target.dataset;

    if (action === "sync") requestSync();
    if (action === "toggleAutoSync") toggleAutoSync();
    if (action === "settings") {
      const nextView = state.view === "settings" ? "list" : "settings";

      if (nextView === "settings") {
        state.profileDraftImageId = state.settings.profileImageId;
      }

      state.view = nextView;
      render();
    }
    if (action === "pin") togglePin(key);
    if (action === "memo") toggleMemo(key);
    if (action === "memoEdit") editMemo(key);
    if (action === "memoCancel") cancelMemoEdit(key);
    if (action === "memoSave") saveMemo(key);
    if (action === "toggleProfileDropdown") toggleProfileDropdown();
    if (action === "selectProfileImage") selectProfileImage(profileId);
    if (action === "saveSettings") saveSettings();
    if (action === "toggleBranches") toggleBranches();
    if (action === "checkoutBranch") checkoutBranch(branch);
    if (action === "editBranchAlias") editBranchAlias(branch);
    if (action === "saveAliasEdit") saveBranchAlias();
    if (action === "cancelAliasEdit") closeAliasEditor();
    if (action === "confirmCheckout") confirmCheckout(mode);
    if (action === "cancelCheckout") closeCheckoutGuard();
    if (action === "testConnection") post("testJiraConnection");

    if (action === "open") {
      event.preventDefault();
      post("openJira", { key });
    }

    if (action === "openExternal") {
      event.preventDefault();
      post("openExternal", { url: target.dataset.url });
    }
  });

  els.tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      state.filter = tab.dataset.filter;
      render();
    });
  });

  els.searchInput.addEventListener("input", (event) => {
    state.keyword = event.target.value;
    render();
  });

  document.addEventListener("keydown", (event) => {
    if (!event.target.matches?.(".jira-panel__branch-alias-input")) return;
    if (event.key === "Enter") saveBranchAlias();
    if (event.key === "Escape") closeAliasEditor();
  });

  window.addEventListener("message", (event) => {
    const { type, payload } = event.data || {};

    if (type === "state") {
      mergeState({
        ...payload,
        ready: true,
        loading: {
          ...state.loading,
          ...(payload?.loading || {}),
          jira: false,
          branch: false,
        },
      });
      render();
    }

    if (type === "issues") {
      setLoading("jira", false);
      mergeState(payload);
      render();
    }

    if (type === "syncError") {
      setLoading("jira", false);
      render();
      showToast(payload?.message || "Jira 동기화 실패");
    }

    if (type === "checkoutResult") {
      setLoading("branch", false);
      if (payload?.ok) {
        state.branchName = payload.branchName;
        state.hasDirtyChanges = Boolean(payload.hasDirtyChanges);
        mergeState({
          branchName: payload.branchName,
          branches: payload.branches || state.branches,
          hasDirtyChanges: Boolean(payload.hasDirtyChanges),
        });
        render();
        showToast(
          `${getBranchIssueKey(payload.branchName) || "브랜치"} 이동 완료`,
        );
      } else {
        render();
        openCheckoutGuard(
          payload?.branchName || state.pendingCheckoutBranch,
          payload?.message ||
            "현재 변경사항이 이동할 브랜치와 충돌할 수 있어요.",
        );
        showToast("그냥 이동할 수 없어요");
      }
    }

    if (type === "connectionResult") {
      showToast(
        payload?.ok ? "Jira 연결 성공" : payload?.message || "Jira 연결 실패",
      );
    }
  });
}

hydrateViewState();
bindEvents();
render();
post("ready");
