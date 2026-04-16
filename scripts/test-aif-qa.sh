#!/bin/bash
# Smoke tests for /aif-qa: branch-slug algorithm correctness and skill contract.
# Usage: ./scripts/test-aif-qa.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILL_DIR="$ROOT_DIR/skills/aif-qa"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

PASSED=0
FAILED=0

pass() {
    PASSED=$((PASSED + 1))
    echo -e "  ${GREEN}✓${NC} $1"
}

fail() {
    FAILED=$((FAILED + 1))
    echo -e "  ${RED}✗${NC} $1"
}

# Reference implementation of the branch-slug algorithm documented in
# skills/aif-qa/SKILL.md Step 0.2. Kept in lock-step with the skill's
# three-step spec: safe_slug, 8-char hash of the original branch name, combine.
aif_qa_slug() {
    local branch="$1"
    local safe_slug
    safe_slug=$(printf '%s' "$branch" | sed -E 's|[^A-Za-z0-9._-]|-|g; s|-+|-|g; s|^-||; s|-$||')
    if [[ -z "$safe_slug" ]]; then
        safe_slug="branch"
    fi
    safe_slug="${safe_slug:0:40}"
    local hash8
    hash8=$(git hash-object --stdin <<< "$branch" | head -c 8)
    printf '%s-%s\n' "$safe_slug" "$hash8"
}

# ─────────────────────────────────────────────
# Part 1: branch-slug algorithm (branch-key uniqueness)
# ─────────────────────────────────────────────
echo -e "\n${BOLD}=== /aif-qa branch-slug algorithm ===${NC}\n"

# Test 1: classic collision case that motivated the P1 fix in PR #68
s1=$(aif_qa_slug "feature/foo")
s2=$(aif_qa_slug "feature-foo")
if [[ "$s1" != "$s2" ]]; then
    pass "feature/foo vs feature-foo are distinct ($s1 ≠ $s2)"
else
    fail "feature/foo and feature-foo collapsed to $s1"
fi

# Test 2: multi-way injectivity — 4 branches that all share the same safe_slug
# 'feat-x', plus two that differ on safe_slug. All 6 must produce unique slugs.
branches=('feat/x' 'feat-x' 'feat x' 'feat--x' 'feat.x' 'feat_x')
slugs=()
for b in "${branches[@]}"; do
    slugs+=("$(aif_qa_slug "$b")")
done
unique_count=$(printf '%s\n' "${slugs[@]}" | sort -u | wc -l | tr -d ' ')
if [[ "$unique_count" -eq "${#branches[@]}" ]]; then
    pass "${#branches[@]} colliding branches → ${#branches[@]} unique slugs"
else
    fail "expected ${#branches[@]} unique slugs, got $unique_count"
    for i in "${!branches[@]}"; do
        echo "      '${branches[$i]}' → ${slugs[$i]}"
    done
fi

# Test 3: filesystem-safe output for exotic characters
s=$(aif_qa_slug 'feat/foo<bar>*?')
if [[ "$s" =~ ^[A-Za-z0-9._-]+$ ]]; then
    pass "slug is filesystem-safe for exotic branch: $s"
else
    fail "slug contains unsafe chars: $s"
fi

# Test 4: empty-ish branch (all special chars) still produces a valid slug
s=$(aif_qa_slug "///")
if [[ -n "$s" && "$s" =~ ^[A-Za-z0-9._-]+$ ]]; then
    pass "branch '///' produces non-empty safe slug: $s"
else
    fail "branch '///' produced bad slug: '$s'"
fi

# Test 5: slug always ends with an 8-char lowercase hex hash suffix
s=$(aif_qa_slug "main")
if [[ "$s" =~ -[0-9a-f]{8}$ ]]; then
    pass "slug ends with 8-char hex hash: $s"
else
    fail "slug missing 8-char hex hash suffix: $s"
fi

# Test 6: deterministic — same input always produces the same slug
s1=$(aif_qa_slug "feature/x")
s2=$(aif_qa_slug "feature/x")
if [[ "$s1" == "$s2" ]]; then
    pass "slug is deterministic"
else
    fail "non-deterministic slug: $s1 vs $s2"
fi

# ─────────────────────────────────────────────
# Part 2: skill contract (explicit-branch flow, --all mode, stage handoff)
# ─────────────────────────────────────────────
echo -e "\n${BOLD}=== /aif-qa skill contract ===${NC}\n"

# Contract: SKILL.md documents the injective slug encoding
if grep -qi 'injective' "$SKILL_DIR/SKILL.md"; then
    pass "SKILL.md documents injective branch-slug encoding"
else
    fail "SKILL.md must mention 'injective' branch-slug encoding"
fi

# Contract: SKILL.md specifies git hash-object as the hash step
if grep -q 'git hash-object' "$SKILL_DIR/SKILL.md"; then
    pass "SKILL.md specifies git hash-object for hash suffix"
else
    fail "SKILL.md must reference git hash-object"
fi

# Contract: SKILL.md documents the explicit-branch argument flow
if grep -q 'branch was provided in arguments' "$SKILL_DIR/SKILL.md"; then
    pass "SKILL.md documents explicit-branch argument flow"
else
    fail "SKILL.md must document explicit-branch flow"
fi

# Contract: SKILL.md documents --all mode
if grep -q 'all_mode' "$SKILL_DIR/SKILL.md" && grep -q -- '--all' "$SKILL_DIR/SKILL.md"; then
    pass "SKILL.md documents --all mode"
else
    fail "SKILL.md must document --all mode"
fi

# Contract: stage references propagate resolved_branch across all three stages
for stage in CHANGE-SUMMARY TEST-PLAN TEST-CASES; do
    ref_file="$SKILL_DIR/references/${stage}.md"
    if [[ -f "$ref_file" ]] && grep -q 'resolved_branch' "$ref_file"; then
        pass "references/${stage}.md uses resolved_branch for stage handoff"
    else
        fail "references/${stage}.md must reference resolved_branch"
    fi
done

# Contract: allowed-tools covers both Bash(git *) and Bash(mkdir *)
# (an earlier PR review caught a mismatch between instructions and permissions)
allowed_line=$(grep -E '^allowed-tools:' "$SKILL_DIR/SKILL.md" || true)
if [[ "$allowed_line" == *"Bash(git *)"* && "$allowed_line" == *"Bash(mkdir *)"* ]]; then
    pass "SKILL.md allowed-tools covers Bash(git *) and Bash(mkdir *)"
else
    fail "SKILL.md allowed-tools must include Bash(git *) and Bash(mkdir *)"
fi

# ─────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────
TOTAL=$((PASSED + FAILED))
echo ""
echo -e "${BOLD}Total:${NC} $TOTAL, ${GREEN}Passed:${NC} $PASSED, ${RED}Failed:${NC} $FAILED"

if [[ $FAILED -gt 0 ]]; then
    exit 1
fi
exit 0
