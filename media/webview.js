const vscode = acquireVsCodeApi();
const STATUS_LABELS = {
  all: "All",
  todo: "Todo",
  doing: "Doing",
  done: "Done",
};
const state = {
  view: "list",
  scopeFilters: {
    linked: false,
  },
  statusFilter: "all",
  statusSelectOpen: false,
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
  branchLoadingText: "브랜치 확인 중",
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
  searchMode: document.querySelector(".jira-search-mode"),
  filterStack: document.querySelector(".jira-filter-stack"),
  searchInput: document.querySelector("#searchInput"),
  tabs: [...document.querySelectorAll("[data-filter]")],
  counts: [...document.querySelectorAll("[data-count]")],
  statusSelect: document.querySelector("#statusSelect"),
  statusSelectTrigger: document.querySelector("#statusSelectTrigger"),
  statusSelectLabel: document.querySelector("#statusSelectLabel"),
  statusSelectMenu: document.querySelector("#statusSelectMenu"),
  statusSelectIcon: document.querySelector("#statusSelectIcon"),
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
  state.scopeFilters = {
    linked: false,
    ...(state.scopeFilters || {}),
  };
  state.statusSelectOpen = Boolean(state.statusSelectOpen);
  state.statusFilter = state.statusFilter || "all";
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
function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[._,/#!%^&*;:{}=+~()'"?<>@`|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getSearchTokens(value) {
  return normalizeSearchText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean);
}

function matchesSearch(issue, keyword) {
  const tokens = getSearchTokens(keyword);
  if (!tokens.length) return true;

  const haystack = normalizeSearchText(
    [
      issue.key,
      issue.title,
      issue.memo,
      issue.assignee,
      issue.reporter,
      issue.statusCategory,
      issue.epicKey,
    ].join(" "),
  );

  return tokens.every((token) => haystack.includes(token));
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

function updateSearchMode() {
  const isSearchMode = Boolean(state.keyword.trim());

  if (els.searchMode) {
    els.searchMode.hidden = !isSearchMode;
  }

  if (els.filterStack) {
    els.filterStack.hidden = isSearchMode;
  }
}

function updateStatusSelect() {
  const labels = {
    all: "All",
    todo: "Todo",
    doing: "Doing",
    done: "Done",
  };

  if (els.statusSelectLabel) {
    els.statusSelectLabel.textContent = labels[state.statusFilter] || "All";
  }

  if (els.statusSelectTrigger) {
    els.statusSelectTrigger.setAttribute(
      "aria-expanded",
      String(state.statusSelectOpen),
    );
  }

  if (els.statusSelectMenu) {
    els.statusSelectMenu.hidden = !state.statusSelectOpen;
  }

  if (els.statusSelectIcon) {
    els.statusSelectIcon.className = `codicon ${
      state.statusSelectOpen ? "codicon-chevron-up" : "codicon-chevron-down"
    }`;
  }

  if (els.statusSelectMenu) {
    els.statusSelectMenu.querySelectorAll("[data-filter]").forEach((button) => {
      button.setAttribute(
        "aria-selected",
        String(button.dataset.filter === state.statusFilter),
      );
    });
  }
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

  if (state.loading.branch) {
    els.branchName.classList.add("jira-panel__branch-loading-text");
    els.branchName.innerHTML = `
      ${escapeHtml(state.branchLoadingText || "브랜치 확인 중")}
      <span class="jira-panel__branch-loading-dots" aria-hidden="true">
        <i></i><i></i><i></i>
      </span>
    `;
  } else {
    els.branchName.classList.remove("jira-panel__branch-loading-text");
    els.branchName.textContent = state.branchName || "브랜치 없음";
  }
  if (els.dirtyDot) {
    els.dirtyDot.hidden = state.loading.branch || !state.hasDirtyChanges;
  }
  els.branchMoreButton.disabled = state.loading.branch;

  renderBranches();
}

function renderBranches() {
  const branches = state.branches.slice(0, 8);
  const hiddenCount = state.branches.slice(0, 8).length;

  els.branchList.classList.toggle(
    "jira-panel__branch-list--expanded",
    state.branchExpanded,
  );
  els.branchMoreButton.setAttribute(
    "aria-expanded",
    String(state.branchExpanded),
  );
  els.branchMoreButton.innerHTML = `
    <span>Branches</span>
    <span class="codicon ${
      state.branchExpanded ? "codicon-chevron-up" : "codicon-chevron-down"
    }" aria-hidden="true"></span>
  `;
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
  const branchKey = getBranchIssueKey(state.branchName);

  const linkedCount = state.issues.reduce((acc, issue) => {
    const isLinked =
      Boolean(branchKey) &&
      (issue.key === branchKey || issue.epicKey === branchKey);

    return acc + (isLinked ? 1 : 0);
  }, 0);

  const scopedIssues = state.issues.filter((issue) => {
    const isLinked =
      Boolean(branchKey) &&
      (issue.key === branchKey || issue.epicKey === branchKey);

    return !state.scopeFilters?.linked ? true : isLinked;
  });

  const statusCounts = scopedIssues.reduce(
    (acc, issue) => {
      acc.all += 1;
      acc[issue.statusCategory] = (acc[issue.statusCategory] || 0) + 1;
      return acc;
    },
    { all: 0, todo: 0, doing: 0, done: 0 },
  );

  els.counts.forEach((count) => {
    const key = count.dataset.count;

    if (key === "linked") {
      count.textContent = linkedCount;
      return;
    }

    count.textContent = statusCounts[key] || 0;
  });

  if (els.statusSelectLabel) {
    els.statusSelectLabel.textContent = `${STATUS_LABELS[state.statusFilter] || "All"} · ${statusCounts[state.statusFilter] || 0}`;
  }
}

function getVisibleIssues() {
  const keyword = getSearchKeyword();
  const branchKey = getBranchIssueKey(state.branchName);
  const hasLinkedFilter = Boolean(state.scopeFilters?.linked);

  return state.issues
    .filter((issue) => {
      if (keyword) return true;

      const isLinked =
        Boolean(branchKey) &&
        (issue.key === branchKey || issue.epicKey === branchKey);

      const matchesScope = !hasLinkedFilter ? true : isLinked;
      const matchesStatus =
        state.statusFilter === "all"
          ? true
          : issue.statusCategory === state.statusFilter;

      return matchesScope && matchesStatus;
    })
    .filter((issue) => matchesSearch(issue, keyword))
    .sort((a, b) => {
      const getRank = (issue) => {
        if (issue.pinned) return 0;
        if (branchKey && issue.key === branchKey) return 1;
        if (branchKey && issue.epicKey === branchKey) return 2;
        return 3;
      };

      return getRank(a) - getRank(b);
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
      const isActiveBranch =
        Boolean(branchKey) &&
        (issue.key === branchKey || issue.epicKey === branchKey);
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
                ${isActiveBranch ? `<span class="jira-card__tag">${issue.key === branchKey ? "current" : "epic current"}</span>` : ""}
              </div>
              <p class="jira-card__title">${highlightText(issue.title)}</p>
            </div>
            <div class="jira-card__actions">
              <button class="jira-card__action" type="button" data-action="pin" data-key="${escapeAttr(issue.key)}" aria-pressed="${issue.pinned}" title="자주 보는 Jira 고정"><span class="codicon ${issue.pinned ? "codicon-star-full" : "codicon-star-empty"}" aria-hidden="true"></span></button>
            </div>
          </div>
          <div class="jira-card__meta">
            <span>${highlightText(issue.reporter ? `${issue.reporter}` : issue.assignee || "")}</span>
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

  const hasLinkedFilter = Boolean(state.scopeFilters?.linked);

  if (
    !hasLinkedFilter &&
    state.statusFilter === "all" &&
    !state.keyword.trim()
  ) {
    return `
      <div class="jira-empty">
        <strong class="jira-empty__title">표시할 Jira가 없습니다.</strong>
        <p class="jira-empty__desc">새로고침하거나 Jira 연결 설정을 확인해 주세요.</p>
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
  updateSearchMode();
  updateStatusSelect();
  updateHeader();
  updateSettingsForm();
  updateView();
  updateCounts();

  els.searchInput.value = state.keyword;

  const isSearching = Boolean(getSearchKeyword());

  document.querySelectorAll("[data-scope]").forEach((button) => {
    const scope = button.dataset.scope;
    button.setAttribute(
      "aria-pressed",
      String(Boolean(state.scopeFilters?.[scope])),
    );
    button.disabled = isSearching;
    button.setAttribute("aria-disabled", String(isSearching));
  });

  els.tabs = [...document.querySelectorAll("[data-filter]")];
  els.tabs.forEach((tab) => {
    tab.setAttribute(
      "aria-selected",
      String(tab.dataset.filter === state.statusFilter),
    );
    tab.disabled = isSearching;
    tab.setAttribute("aria-disabled", String(isSearching));
  });

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
    branchLoadingText: "브랜치 확인 중",
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

  // stale dirty 상태 때문에 브랜치 이동이 막히지 않도록
  // 우선 Git checkout을 직접 시도하고, 실패했을 때만 정리 팝업을 띄웁니다.
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
  state.branchLoadingText =
    mode === "stash"
      ? "stash 후 전환 중"
      : mode === "discard"
        ? "변경사항 정리 중"
        : "브랜치 전환 중";

  setLoading("branch", true);
  render();
  post("checkoutBranch", { branchName, mode });
}

function bindEvents() {
  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;

    const { action, key, branch, mode, profileId, scope } = target.dataset;

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
    if (action === "toggleScopeFilter") {
      if (scope === "linked") {
        state.scopeFilters = {
          ...state.scopeFilters,
          [scope]: !state.scopeFilters[scope],
        };
        render();
      }
      return;
    }
    if (action === "toggleStatusSelect") {
      state.statusSelectOpen = !state.statusSelectOpen;
      render();
      return;
    }
    if (action === "selectStatusFilter") {
      state.statusFilter = target.dataset.filter || "all";
      state.statusSelectOpen = false;
      render();
      return;
    }
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
    if (action === "clearSearch") {
      state.keyword = "";

      if (els.searchInput) {
        els.searchInput.value = "";
        els.searchInput.focus();
      }

      render();
      return;
    }
    if (action === "open") {
      event.preventDefault();
      post("openJira", { key });
    }

    if (action === "openExternal") {
      event.preventDefault();
      post("openExternal", { url: target.dataset.url });
    }
  });

  document.addEventListener("click", (event) => {
    if (
      state.statusSelectOpen &&
      els.statusSelect &&
      !els.statusSelect.contains(event.target)
    ) {
      state.statusSelectOpen = false;
      render();
    }
  });

  els.searchInput.addEventListener("input", (event) => {
    state.keyword = event.target.value;
    render();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.statusSelectOpen) {
      state.statusSelectOpen = false;
      render();
      return;
    }

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

    if (type === "branchProgress") {
      state.branchLoadingText = payload?.message || "브랜치 전환 중";
      setLoading("branch", true);
      render();
    }

    if (type === "checkoutResult") {
      setLoading("branch", false);
      state.branchLoadingText = "브랜치 확인 중";

      if (payload?.ok) {
        mergeState({
          branchName: payload.branchName,
          hasDirtyChanges:
            typeof payload.hasDirtyChanges === "boolean"
              ? payload.hasDirtyChanges
              : state.hasDirtyChanges,
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
        showToast("브랜치 이동 실패");
      }
    }

    if (type === "branchState") {
      mergeState({
        branchName: payload?.branchName || state.branchName,
        branches: payload?.branches || state.branches,
        hasDirtyChanges: Boolean(payload?.hasDirtyChanges),
        branchLoadingText: "브랜치 확인 중",
        loading: {
          ...state.loading,
          branch: false,
        },
      });

      render();
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
