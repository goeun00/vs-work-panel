# Jira Work Panel

A lightweight VS Code sidebar panel for Jira issues, pins, memos, and branch-based workflow.

## Run locally

1. Unzip this folder.
2. Open the folder in VS Code.
3. Press `F5` to launch an Extension Development Host.
4. Open the Jira icon in the left Activity Bar.
5. Open settings in the panel and save:
   - Jira Base URL
   - API Token / PAT
   - JQL

Token is stored in VS Code `SecretStorage`.
Pins, memos, and branch aliases are stored in workspace storage.

## Notes

- `statusCategory` is mapped as:
  - Jira `new` → Todo
  - Jira `indeterminate` → Doing
  - Jira `done` → Done
- Branch checkout supports:
  - Stash & Checkout
  - Discard & Checkout
  - Done Change
