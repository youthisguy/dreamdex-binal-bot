#!/usr/bin/env bash
# Render Start Command:
#   bash scripts/restore-and-start.sh bot         (trading loop service)
#   bash scripts/restore-and-start.sh dashboard   (dashboard service)
#
# Pulls the last checkpointed logs/ (decisions.jsonl) from GitHub before
# booting, so a fresh deploy on either service starts with full trade
# history instead of an empty journal.
#
# Docker-built deploys typically COPY specific folders into the image and
# never include .git, so this may be running in a directory that isn't a
# git repo yet. If so, initialize one, add the remote, and fetch — this
# runs BEFORE the app has written anything to logs/, so there's nothing on
# disk yet to conflict with the checkout below.
set -euo pipefail

MODE="${1:-bot}"
if [ "$MODE" != "bot" ] && [ "$MODE" != "dashboard" ]; then
  echo "[boot] unknown mode '$MODE' — expected 'bot' or 'dashboard'"
  exit 1
fi

echo "[boot] fetching latest committed logs/ from git..."

BRANCH="${GIT_BRANCH:-main}"
PATHS="${CHECKPOINT_PATHS:-logs}"

if [ ! -d .git ]; then
  if [ -n "${GITHUB_REPO:-}" ] && [ -n "${GITHUB_TOKEN:-}" ]; then
    echo "[boot] no .git at runtime — initializing"
    git init -q
  else
    echo "[boot] no .git at runtime and GITHUB_REPO/GITHUB_TOKEN not set — skipping restore"
  fi
fi

if [ -d .git ]; then
  if ! git remote get-url origin >/dev/null 2>&1; then
    if [ -n "${GITHUB_REPO:-}" ] && [ -n "${GITHUB_TOKEN:-}" ]; then
      echo "[boot] origin remote missing — reconstructing from GITHUB_REPO/GITHUB_TOKEN"
      git remote add origin "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git"
    else
      echo "[boot] origin remote missing and GITHUB_REPO/GITHUB_TOKEN not set — skipping restore"
    fi
  fi

  if git remote get-url origin >/dev/null 2>&1; then
    git fetch origin "$BRANCH" --quiet || echo "[boot] git fetch failed, continuing with what's on disk"

    # If this is a repo that was just `git init`'d above (or any repo with
    # zero commits yet), it has NO history at all. A path-scoped
    # `checkout -- $PATHS` below only copies file contents into the working
    # tree — it does NOT give this branch any ancestry. If checkpoint.sh
    # later commits on top of that, the resulting commit has no parent, and
    # its future `git merge origin/$BRANCH` fails with "refusing to merge
    # unrelated histories" every single time.
    #
    # Fix: when HEAD has no commit yet, adopt origin/$BRANCH's tip as this
    # branch's history via a mixed reset. This only moves the branch ref
    # and the index — it does NOT touch the working tree — so it's safe to
    # do before the path-scoped checkout below, and it gives future local
    # commits a shared ancestor with origin so merges resolve normally.
    if ! git rev-parse --verify -q HEAD >/dev/null; then
      if git rev-parse --verify -q "origin/$BRANCH" >/dev/null; then
        echo "[boot] no local commits yet — adopting origin/$BRANCH as history"
        git symbolic-ref HEAD "refs/heads/$BRANCH"
        git reset "origin/$BRANCH" >/dev/null
      else
        echo "[boot] no local commits and no origin/$BRANCH yet (first run) — leaving history empty"
      fi
    fi

    # Only restore the tracked paths — never touch anything else that
    # might differ between the deployed build and HEAD. Works even with
    # zero local commits: this checks out blobs from the fetched
    # remote-tracking ref directly, it doesn't need an existing HEAD.
    # shellcheck disable=SC2086
    git checkout "origin/$BRANCH" -- $PATHS 2>/dev/null \
      && echo "[boot] restored $PATHS from origin" \
      || echo "[boot] no $PATHS on origin yet (first run) or checkout failed, continuing with local $PATHS"
  fi
else
  echo "[boot] skipping restore"
fi

echo "[boot] starting $MODE..."
case "$MODE" in
  bot)
    exec npm start -w ec-oracle-follow
    ;;
  dashboard)
    exec node dashboard/prod-server.mjs
    ;;
esac